import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { selfCommand } from "@dg/common/node";
import { openInBrowser } from "../prototype/ui";
import {
	addSection,
	addVariant,
	assertVariantKey,
	chains,
	clip,
	dropPending,
	formatStatus,
	readBoard,
	readVerdicts,
	resolveSessionDir,
	reworkChains,
	roundOf,
	setPending,
	statusReport,
	verdictLabel,
	verifyPaths,
	writeBoard,
	type BoardImage,
	type Section,
	type VerifyPaths,
} from "./board";
import { captureSession, sectionFromCapture, type CaptureTarget } from "./capture";
import type { Capturer } from "./capture-model";
import { createHttpCapturer } from "./http-capturer";
import { parseManifest } from "./manifest";
import { assertVerifyName } from "./names";
import { startVerifyServer } from "./serve";
import { loadManifest, saveManifest } from "./session";

export const USAGE = `Usage: verify <command> <name> [options]

  serve <name> [--port=N] [--no-open]           Start the review board in the background and print its URL
  status <name> [--json]                        One line per item: rounds, state, latest note
  add <name> <id> --title=T [--summary=S] [--what=W] [--branch=B] [--follows=ID] [--round=N] [--pending=KEY]
      (--shots=DIR [--prefix=P] | --img="label|before|after[|reason]" ...)
      [--variant=KEY [--variant-label=L] [--variant-summary=S]]
                                                Add a round from screenshots you took yourself.
                                                With --variant, add one version; run once per version
  pending add <name> <key> --title=T [--detail=D] [--follows=ID]
  pending done <name> <key>                     Show or clear an "agent working" entry
  watch <name>                                  Print one line per new verdict until stopped
  wait <name> [--timeout=SEC] [--json]          Block until every round has a verdict, then print status
  stop <name>                                   Stop the board server
  title <name> <text>                           Set the board title shown in the nav and the tab; empty text clears it
  capture <name> [--manifest=FILE] [--items=a,b] [--summary=S] [--engine=http|playwright]
                                                Capture items from the manifest as their next round
  rerun <name> [--summary=S] [--engine=http|playwright]
                                                Recapture rounds sent back or approved with a note

  Every command takes --dir=PATH. The default session is .agents/verify/<name>/.
`;

const DEFAULT_TIMEOUT_SEC = 900;
const POLL_MS = 500;
const WATCH_MS = 2000;
const SERVER_START_MS = 10_000;
const BOUND_LINE = /^verify-serve: http:\/\/127\.0\.0\.1:(\d+)\//;

interface Flags {
	values: Map<string, string[]>;
	bools: Set<string>;
	rest: string[];
}

const BOOLEAN = new Set(["json", "no-open", "foreground"]);

function parseFlags(argv: string[]): Flags {
	const flags: Flags = { values: new Map(), bools: new Set(), rest: [] };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index] ?? "";
		if (!arg.startsWith("--")) {
			flags.rest.push(arg);
			continue;
		}
		const eq = arg.indexOf("=");
		const key = arg.slice(2, eq === -1 ? undefined : eq);
		if (BOOLEAN.has(key) && eq === -1) {
			flags.bools.add(key);
			continue;
		}
		const value = eq === -1 ? argv[++index] : arg.slice(eq + 1);
		if (value === undefined) throw new Error(`--${key} needs a value`);
		flags.values.set(key, [...(flags.values.get(key) ?? []), value]);
	}
	return flags;
}

const one = (flags: Flags, key: string) => flags.values.get(key)?.at(-1);

function integer(flags: Flags, key: string, min: number, max: number): number | undefined {
	const raw = one(flags, key);
	if (raw === undefined) return undefined;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < min || value > max) throw new Error(`invalid --${key}: ${raw}`);
	return value;
}

function write(text: string): void {
	process.stdout.write(text);
}

function fail(message: string): number {
	process.stderr.write(`verify: ${message}\n`);
	return 1;
}

async function openCapturer(flags: Flags): Promise<Capturer> {
	const engine = one(flags, "engine") ?? "playwright";
	if (engine === "http") return createHttpCapturer();
	if (engine !== "playwright") throw new Error("--engine must be http or playwright");
	const { openPlaywrightCapturer } = await import("./playwright-capturer");
	return openPlaywrightCapturer();
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function readServer(paths: VerifyPaths): { pid: number; port: number } | undefined {
	try {
		const state = JSON.parse(readFileSync(paths.server, "utf8")) as { pid: number; port: number };
		return isAlive(state.pid) ? state : undefined;
	} catch {
		return undefined;
	}
}

async function launch(name: string, paths: VerifyPaths, port: number): Promise<{ pid: number; port: number }> {
	const proc = Bun.spawn({
		cmd: selfCommand(["verify", "serve", name, "--foreground", `--port=${port}`, `--dir=${paths.dir}`]),
		stdout: "pipe",
		stderr: "ignore",
		stdin: "ignore",
	});
	const reader = proc.stdout.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let bound: number | undefined;
	const deadline = Date.now() + SERVER_START_MS;
	while (bound === undefined && Date.now() < deadline) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const match = BOUND_LINE.exec(buffer);
		if (match) bound = Number(match[1]);
	}
	reader.releaseLock();
	if (bound === undefined) {
		proc.kill();
		throw new Error("verify serve did not report a bound port within 10s");
	}
	proc.unref();
	return { pid: proc.pid, port: bound };
}

async function runServe(name: string, paths: VerifyPaths, flags: Flags): Promise<number | undefined> {
	const port = integer(flags, "port", 0, 65535) ?? 0;
	if (flags.bools.has("foreground")) {
		const running = await startVerifyServer({ name, paths, port });
		write(`verify-serve: http://127.0.0.1:${running.port}/\n`);
		return undefined;
	}
	const state = readServer(paths) ?? (await launch(name, paths, port));
	mkdirSync(paths.dir, { recursive: true });
	writeFileSync(paths.server, `${JSON.stringify(state)}\n`);
	const url = `http://127.0.0.1:${state.port}/`;
	write(`verify: ${url}\n`);
	if (!flags.bools.has("no-open") && !(await openInBrowser(url)))
		process.stderr.write(`verify: no browser opener found; visit: ${url}\n`);
	return 0;
}

function runStop(name: string, paths: VerifyPaths): number {
	const state = readServer(paths);
	if (state) process.kill(state.pid, "SIGTERM");
	rmSync(paths.server, { force: true });
	write(`${state ? "stopped" : "not running"} ${name}\n`);
	return 0;
}

function runStatus(name: string, paths: VerifyPaths, flags: Flags): number {
	write(formatStatus(statusReport(readBoard(paths, name), readVerdicts(paths)), flags.bools.has("json")));
	return 0;
}

async function runWait(name: string, paths: VerifyPaths, flags: Flags): Promise<number> {
	const deadline = Date.now() + (integer(flags, "timeout", 0, 86_400) ?? DEFAULT_TIMEOUT_SEC) * 1000;
	for (;;) {
		const report = statusReport(readBoard(paths, name), readVerdicts(paths));
		if (report.reviewed) {
			write(formatStatus(report, flags.bools.has("json"), 4000));
			return 0;
		}
		if (Date.now() >= deadline) {
			write("timeout\n");
			return 1;
		}
		await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
	}
}

async function runWatch(paths: VerifyPaths): Promise<never> {
	const seen = new Map(Object.entries(readVerdicts(paths)).map(([id, verdict]) => [id, verdict.at]));
	for (;;) {
		await sleep(WATCH_MS);
		let current;
		try {
			current = readVerdicts(paths);
		} catch {
			continue;
		}
		for (const [id, verdict] of Object.entries(current)) {
			if (seen.get(id) === verdict.at) continue;
			seen.set(id, verdict.at);
			write(`${id} ${verdictLabel(verdict)}${verdict.note ? ` | ${clip(verdict.note, 400)}` : ""}\n`);
		}
	}
}

const widthOf = (name: string) =>
	/(^|\D)(390|375|360)(\D|$)/.test(name) ? "mobile" : /(^|\D)(768|820|1024)(\D|$)/.test(name) ? "tablet" : "desktop";

function servedName(file: string): string {
	return basename(file).toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^[^a-z0-9]+/, "");
}

function importShot(paths: VerifyPaths, folder: string, file: string, name = servedName(file)): string {
	const source = resolve(file);
	if (!source.endsWith(".png")) throw new Error(`not a png: ${file}`);
	if (!existsSync(source)) throw new Error(`no such file: ${file}`);
	const dir = join(paths.shotsDir, folder);
	mkdirSync(dir, { recursive: true });
	copyFileSync(source, join(dir, name));
	return `/shots/${folder}/${name}`;
}

function imagesFromDir(paths: VerifyPaths, folder: string, dir: string, prefix: string): BoardImage[] {
	const files = new Set(readdirSync(resolve(dir)));
	const names = [...files]
		.filter((file) => file.startsWith(`${prefix}after-`) && file.endsWith(".png"))
		.map((file) => file.slice(`${prefix}after-`.length, -4))
		.sort();
	if (names.length === 0) throw new Error(`no ${prefix}after-*.png in ${dir}`);
	return names.map((shot) => {
		const before = `${prefix}before-${shot}.png`;
		const after = importShot(paths, folder, join(dir, `${prefix}after-${shot}.png`));
		if (!files.has(before)) return { label: `${widthOf(shot)} · ${shot}`, before: "missing", after, reason: "no before captured" };
		return { label: `${widthOf(shot)} · ${shot}`, before: importShot(paths, folder, join(dir, before)), after };
	});
}

function runAdd(name: string, paths: VerifyPaths, flags: Flags): number {
	const id = flags.rest[1];
	const title = one(flags, "title");
	if (!id || !title) return fail("add needs <name> <id> --title=T");
	assertVerifyName(id, "section");
	const variant = one(flags, "variant");
	if (variant) assertVariantKey(variant);
	const board = readBoard(paths, name);
	const follows = one(flags, "follows");
	if (follows && !board.sections.some((section) => section.id === follows)) return fail(`follows ${follows} not found`);
	const folder = `${id}/${variant ? `v-${variant.toLowerCase()}` : "added"}`;
	const shots = one(flags, "shots");
	const images = shots
		? imagesFromDir(paths, folder, shots, one(flags, "prefix") ?? "")
		: (flags.values.get("img") ?? []).map((spec, index) => {
				const [label, before, after, reason] = spec.split("|");
				if (!label || !after) throw new Error(`--img needs "label|before|after": ${spec}`);
				const image: BoardImage = {
					label,
					before: before && before !== "missing" ? importShot(paths, folder, before, `${index + 1}-before-${servedName(before)}`) : "missing",
					after: importShot(paths, folder, after, `${index + 1}-after-${servedName(after)}`),
				};
				if (reason) image.reason = reason;
				return image;
			});
	if (images.length === 0) return fail("no images: pass --shots=DIR or --img");
	const section: Section = { id, title, images };
	const optional = { summary: one(flags, "summary"), branch: one(flags, "branch"), what_changed: one(flags, "what"), follows };
	for (const [key, value] of Object.entries(optional)) if (value) Object.assign(section, { [key]: value });
	const round = integer(flags, "round", 1, 999);
	if (round) section.round = round;
	const missing = `${images.length} images (${images.filter((image) => image.before === "missing").length} without before)`;
	if (!variant) {
		writeBoard(paths, addSection(board, section, one(flags, "pending")));
		write(`added ${id}: ${missing}\n`);
		return 0;
	}
	const entry = { key: variant, images, label: one(flags, "variant-label"), summary: one(flags, "variant-summary") };
	for (const key of ["label", "summary"] as const) if (!entry[key]) delete entry[key];
	const next = addVariant(board, section, entry, one(flags, "pending"));
	const count = next.sections.find((candidate) => candidate.id === id)?.variants?.length ?? 0;
	writeBoard(paths, next);
	write(`added ${id} version ${variant} (${count} versions): ${missing}\n`);
	return 0;
}

function runTitle(name: string, paths: VerifyPaths, flags: Flags): number {
	const text = flags.rest.slice(1).join(" ").trim();
	if (text.length > 120) return fail("title must be at most 120 characters");
	const { title: _old, ...board } = readBoard(paths, name);
	writeBoard(paths, text ? { ...board, title: text } : board);
	write(text ? `title ${name}: ${text}\n` : `title ${name}: cleared\n`);
	return 0;
}

function runPending(name: string, paths: VerifyPaths, flags: Flags, sub: string): number {
	const key = flags.rest[1];
	if (!key) return fail("pending needs <name> <key>");
	let board = readBoard(paths, name);
	if (sub === "add") {
		const title = one(flags, "title");
		if (!title) return fail("pending add needs --title=T");
		const detail = one(flags, "detail");
		const follows = one(flags, "follows");
		board = setPending(board, { key, title, ...(detail ? { detail } : {}), ...(follows ? { follows } : {}) });
	} else if (sub === "done") board = dropPending(board, key);
	else return fail("pending takes add or done");
	writeBoard(paths, board);
	write(`pending ${sub} ${key}: ${board.pending.length} open\n`);
	return 0;
}

async function captureRounds(
	name: string,
	paths: VerifyPaths,
	flags: Flags,
	plan: { itemId: string; follows?: string; round: number; summary?: string }[],
): Promise<void> {
	const manifest = loadManifest(paths);
	let board = readBoard(paths, name);
	const targets: CaptureTarget[] = plan.map((entry) => ({ itemId: entry.itemId, sectionId: `${entry.itemId}-r${entry.round}` }));
	for (const [index, entry] of plan.entries()) {
		const item = manifest.items.find((candidate) => candidate.id === entry.itemId);
		const pending = { key: targets[index]?.sectionId ?? "", title: item?.title ?? entry.itemId, detail: entry.summary ?? "Capturing" };
		board = setPending(board, entry.follows ? { ...pending, follows: entry.follows } : pending);
	}
	writeBoard(paths, board);
	let captured;
	try {
		const capturer = await openCapturer(flags);
		try {
			captured = await captureSession({ manifest, paths, capturer, cwd: process.cwd(), targets });
		} finally {
			await capturer.close();
		}
	} catch (error) {
		writeBoard(paths, targets.reduce((next, target) => dropPending(next, target.sectionId), readBoard(paths, name)));
		throw error;
	}
	board = { ...readBoard(paths, name), stackUrl: manifest.stackUrl };
	for (const [index, result] of captured.entries()) {
		const entry = plan[index];
		if (!entry) continue;
		const section = sectionFromCapture(result, entry);
		board = addSection(board, section, section.id);
		write(`added ${section.id}: ${section.images.length} images\n`);
	}
	writeBoard(paths, board);
}

async function runCapture(name: string, paths: VerifyPaths, flags: Flags): Promise<number> {
	const file = one(flags, "manifest");
	if (file) saveManifest(paths, parseManifest(JSON.parse(readFileSync(file, "utf8")), name));
	const manifest = loadManifest(paths);
	const wanted = one(flags, "items")?.split(",").map((id) => id.trim()).filter(Boolean) ?? manifest.items.map((item) => item.id);
	const board = readBoard(paths, name);
	const summary = one(flags, "summary");
	const plan = wanted.map((itemId) => {
		const chain = chains(board).find((candidate) => candidate.last.item === itemId);
		if (!chain) return { itemId, round: 1, summary };
		return { itemId, follows: chain.last.id, round: roundOf(chain, chain.rounds.length - 1) + 1, summary: summary ?? "Recaptured" };
	});
	await captureRounds(name, paths, flags, plan);
	return 0;
}

async function runRerun(name: string, paths: VerifyPaths, flags: Flags): Promise<number> {
	const verdicts = readVerdicts(paths);
	const rework = reworkChains(readBoard(paths, name), verdicts);
	for (const chain of rework.filter((candidate) => !candidate.last.item)) write(`skip ${chain.last.id}: no capture item\n`);
	const summary = one(flags, "summary");
	const plan = rework
		.filter((chain) => chain.last.item)
		.map((chain) => ({
			itemId: chain.last.item ?? "",
			follows: chain.last.id,
			round: roundOf(chain, chain.rounds.length - 1) + 1,
			summary: summary ?? `Rework: ${clip(verdicts[chain.last.id]?.note ?? "", 40)}`,
		}));
	if (plan.length === 0) {
		write("nothing-to-recapture\n");
		return 0;
	}
	await captureRounds(name, paths, flags, plan);
	return 0;
}

/** Entry point for every verify command. */
export async function main(argv: string[]): Promise<number | undefined> {
	const [command, ...args] = argv;
	if (!command || command === "--help" || command === "-h") {
		write(USAGE);
		return command ? 0 : 1;
	}
	try {
		const sub = command === "pending" ? args.shift() : undefined;
		const flags = parseFlags(args);
		const name = flags.rest[0];
		if (!name) return fail(`${command} requires a name`);
		const paths = verifyPaths(resolveSessionDir(name, process.cwd(), one(flags, "dir")));
		if (command === "serve") return await runServe(name, paths, flags);
		if (command === "stop") return runStop(name, paths);
		if (command === "status") return runStatus(name, paths, flags);
		if (command === "wait") return await runWait(name, paths, flags);
		if (command === "watch") return await runWatch(paths);
		if (command === "add") return runAdd(name, paths, flags);
		if (command === "pending") return runPending(name, paths, flags, sub ?? "");
		if (command === "title") return runTitle(name, paths, flags);
		if (command === "capture") return await runCapture(name, paths, flags);
		if (command === "rerun") return await runRerun(name, paths, flags);
		process.stderr.write(USAGE);
		return 1;
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	}
}
