import { readFileSync } from "node:fs";
import { openInBrowser } from "../prototype/ui";
import { captureSession } from "./capture";
import type { Capturer } from "./capture-model";
import { createHttpCapturer } from "./http-capturer";
import { parseManifest } from "./manifest";
import { loadManifest, resetSession, saveManifest } from "./session";
import { startVerifyServer } from "./serve";
import {
	claimVerdict,
	forgetItems,
	formatStatus,
	formatVerdict,
	readDecisions,
	resolveSessionDir,
	reworkIds,
	statusReport,
	verifyPaths,
	bumpReload,
	type VerifyPaths,
} from "./verdict";

export const USAGE = `Usage: verify <command> [options]

  start <name> --manifest=<file> [--port=N] [--engine=http|playwright] [--no-open] [--no-capture] [--dir=PATH]
                                                 Capture, serve the review page, and keep it open
  capture <name> [--items=a,b] [--engine=http|playwright] [--dir=PATH]
                                                 Capture every item, or only the named items
  status <name> [--json] [--dir=PATH]            Print each item and whether all are approved
  wait <name> [--timeout=SEC] [--json] [--dir=PATH]
                                                 Block until every item has a pick, then claim it
  rerun <name> [--engine=http|playwright] [--dir=PATH]
                                                 Recapture rejected and tweaked items and reload the open tab
`;

const DEFAULT_PORT = 4377;
const DEFAULT_TIMEOUT_SEC = 900;

interface Flags {
	manifest?: string;
	items?: string[];
	engine: "http" | "playwright";
	port?: number;
	timeoutSec: number;
	json: boolean;
	noOpen: boolean;
	noCapture: boolean;
	dir?: string;
	rest: string[];
}

function integer(arg: string, prefix: string, min: number, max: number): number {
	const value = Number.parseInt(arg.slice(prefix.length), 10);
	if (!Number.isInteger(value) || value < min || value > max)
		throw new Error(`invalid value: ${arg}`);
	return value;
}

function parseFlags(argv: string[]): Flags {
	const flags: Flags = {
		engine: "playwright",
		timeoutSec: DEFAULT_TIMEOUT_SEC,
		json: false,
		noOpen: false,
		noCapture: false,
		rest: [],
	};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index] ?? "";
		if (arg === "--json") flags.json = true;
		else if (arg === "--no-open") flags.noOpen = true;
		else if (arg === "--no-capture") flags.noCapture = true;
		else if (arg.startsWith("--manifest=")) flags.manifest = arg.slice("--manifest=".length);
		else if (arg === "--manifest") flags.manifest = argv[++index];
		else if (arg.startsWith("--items="))
			flags.items = arg
				.slice("--items=".length)
				.split(",")
				.map((item) => item.trim())
				.filter((item) => item.length > 0);
		else if (arg.startsWith("--engine=")) {
			const engine = arg.slice("--engine=".length);
			if (engine !== "http" && engine !== "playwright")
				throw new Error("--engine must be http or playwright");
			flags.engine = engine;
		} else if (arg.startsWith("--port=")) flags.port = integer(arg, "--port=", 0, 65535);
		else if (arg.startsWith("--timeout="))
			flags.timeoutSec = integer(arg, "--timeout=", 0, 86_400);
		else if (arg.startsWith("--dir=")) flags.dir = arg.slice("--dir=".length);
		else if (arg.startsWith("--")) throw new Error(`unknown option: ${arg}`);
		else flags.rest.push(arg);
	}
	return flags;
}

function fail(message: string): number {
	process.stderr.write(`verify: ${message}\n`);
	return 1;
}

async function openCapturer(engine: Flags["engine"]): Promise<Capturer> {
	if (engine === "http") return createHttpCapturer();
	const { openPlaywrightCapturer } = await import("./playwright-capturer");
	return openPlaywrightCapturer();
}

function session(name: string, flags: Flags): VerifyPaths {
	return verifyPaths(resolveSessionDir(name, process.cwd(), flags.dir));
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForVerdict(paths: VerifyPaths, timeoutSec: number) {
	const deadline = Date.now() + timeoutSec * 1000;
	while (true) {
		const found = claimVerdict(paths);
		if (found) return found;
		if (Date.now() >= deadline) return undefined;
		await sleep(Math.min(200, Math.max(0, deadline - Date.now())));
	}
}

async function runStart(name: string, flags: Flags): Promise<number | undefined> {
	if (!flags.manifest) return fail("start requires --manifest=<file>");
	const manifest = parseManifest(JSON.parse(readFileSync(flags.manifest, "utf8")), name);
	const paths = session(name, flags);
	resetSession(paths);
	saveManifest(paths, manifest);
	if (!flags.noCapture) {
		const capturer = await openCapturer(flags.engine);
		try {
			const result = await captureSession({
				manifest,
				paths,
				capturer,
				cwd: process.cwd(),
			});
			process.stderr.write(`verify: captured ${result.shots} shots\n`);
		} finally {
			await capturer.close();
		}
	}
	const running = await startVerifyServer({ paths, port: flags.port ?? DEFAULT_PORT });
	const url = `http://127.0.0.1:${running.port}/`;
	process.stdout.write(`verify: ${url}\n  name : ${name}\n  stack: ${manifest.stackUrl}\n`);
	if (!flags.noOpen) {
		const opened = await openInBrowser(url);
		if (!opened) process.stderr.write(`verify: no browser opener found; visit: ${url}\n`);
	}
	return undefined;
}

async function runCapture(name: string, flags: Flags): Promise<number> {
	const paths = session(name, flags);
	const manifest = loadManifest(paths);
	const capturer = await openCapturer(flags.engine);
	try {
		const result = await captureSession({
			manifest,
			paths,
			capturer,
			cwd: process.cwd(),
			items: flags.items,
		});
		process.stdout.write(`verify: captured ${result.shots} shots\n`);
		return 0;
	} finally {
		await capturer.close();
	}
}

function runStatus(name: string, flags: Flags): number {
	const paths = session(name, flags);
	const manifest = loadManifest(paths);
	process.stdout.write(formatStatus(statusReport(paths, manifest), flags.json));
	return 0;
}

async function runWait(name: string, flags: Flags): Promise<number> {
	const paths = session(name, flags);
	loadManifest(paths);
	const verdict = await waitForVerdict(paths, flags.timeoutSec);
	if (!verdict) {
		process.stdout.write("timeout\n");
		return 1;
	}
	process.stdout.write(formatVerdict(verdict, flags.json));
	return 0;
}

async function runRerun(name: string, flags: Flags): Promise<number> {
	const paths = session(name, flags);
	const manifest = loadManifest(paths);
	const ids = reworkIds(readDecisions(paths));
	if (ids.length === 0) {
		process.stdout.write("nothing-to-recapture\n");
		return 0;
	}
	const capturer = await openCapturer(flags.engine);
	try {
		await captureSession({ manifest, paths, capturer, cwd: process.cwd(), items: ids });
	} finally {
		await capturer.close();
	}
	forgetItems(paths, ids);
	const token = bumpReload(paths);
	process.stdout.write(`verify: recaptured ${ids.join(",")} reload=${token}\n`);
	return 0;
}

/** Entry point for verify start, capture, status, wait, and rerun. */
export async function main(argv: string[]): Promise<number | undefined> {
	const [command] = argv;
	if (!command || command === "--help" || command === "-h") {
		process.stdout.write(USAGE);
		return command ? 0 : 1;
	}
	try {
		const flags = parseFlags(argv.slice(1));
		const name = flags.rest[0];
		if (!name) return fail(`${command} requires a name`);
		if (command === "start") return await runStart(name, flags);
		if (command === "capture") return await runCapture(name, flags);
		if (command === "status") return runStatus(name, flags);
		if (command === "wait") return await runWait(name, flags);
		if (command === "rerun") return await runRerun(name, flags);
		process.stderr.write(USAGE);
		return 1;
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	}
}
