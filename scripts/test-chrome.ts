#!/usr/bin/env bun
/**
 * Internal test Chrome for the dg-ai-extension chat harness.
 *
 * Builds the unpacked extension, then launches Chromium with a dedicated
 * profile and that extension loaded. Optional flags start the local daemon
 * and capture a side-panel-sized screenshot of the chat page.
 *
 *   bun scripts/test-chrome.ts
 *   bun scripts/test-chrome.ts --with-daemon
 *   bun scripts/test-chrome.ts --skip-build --screenshot /tmp/chat.png
 *   mise run ext
 *   mise run harness
 */
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import {
	type ConnectionDropInput,
	type DropMessage,
	logConnectionDrop,
	logHarnessLine,
} from "@dg/common";

const ROOT = resolve(import.meta.dir, "..");
const EXTENSION_DIR = resolve(ROOT, "pkg/extension/.output/chrome-mv3");
const CHAT_PAGE = "chat.html";
const DEBUG_PORT = Number(process.env.DG_TEST_CHROME_PORT ?? 9333);

type Flags = {
	skipBuild: boolean;
	withDaemon: boolean;
	screenshot?: string;
	profile: string;
};

function parseFlags(argv: string[]): Flags {
	const flags: Flags = {
		skipBuild: false,
		withDaemon: false,
		profile:
			process.env.DG_TEST_CHROME_PROFILE ??
			resolve(homedir(), ".dg", "test-chrome"),
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--skip-build") flags.skipBuild = true;
		else if (arg === "--with-daemon") flags.withDaemon = true;
		else if (arg === "--screenshot") {
			const next = argv[++i];
			if (!next) throw new Error("--screenshot needs a file path");
			flags.screenshot = resolve(next);
		} else if (arg === "--profile") {
			const next = argv[++i];
			if (!next) throw new Error("--profile needs a directory");
			flags.profile = resolve(next);
		} else if (arg === "--help" || arg === "-h") {
			console.log(`Usage: bun scripts/test-chrome.ts [--skip-build] [--with-daemon] [--screenshot <png>] [--profile <dir>]

  --with-daemon   start dg-daemon in the background (DG_HOME, default ~/.dg)
  --screenshot    open the chat side panel page at 420×900 and write a PNG
  --skip-build    reuse pkg/extension/.output/chrome-mv3
  --profile       Chromium user-data-dir (default ~/.dg/test-chrome)
`);
			process.exit(0);
		} else {
			throw new Error(`unknown argument: ${arg}`);
		}
	}
	return flags;
}

function run(command: string, args: string[]): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, { cwd: ROOT, stdio: "inherit" });
		child.on("error", reject);
		child.on("exit", (code) => {
			if (code === 0) resolvePromise();
			else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
		});
	});
}

async function ensureExtension(skipBuild: boolean): Promise<void> {
	if (skipBuild) return;
	await run("bun", ["run", "--cwd", "pkg/extension", "build"]);
}

function startDaemon(): ChildProcess {
	const home = process.env.DG_HOME ?? resolve(homedir(), ".dg");
	mkdirSync(home, { recursive: true });
	const child = spawn(
		"bun",
		["pkg/dg-daemon/src/index.ts", "__serve"],
		{
			cwd: ROOT,
			stdio: "inherit",
			env: { ...process.env, DG_HOME: home },
			detached: true,
		},
	);
	child.unref();
	return child;
}

type DebugTarget = {
	id: string;
	type: string;
	url: string;
	webSocketDebuggerUrl?: string;
};

async function waitForTargets(deadline = Date.now() + 20_000): Promise<DebugTarget[]> {
	let lastError = "debugger did not answer";
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
			if (response.ok) return (await response.json()) as DebugTarget[];
			lastError = `debugger HTTP ${response.status}`;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		await Bun.sleep(200);
	}
	throw new Error(`test Chrome debugger never came up: ${lastError}`);
}

function extensionId(targets: DebugTarget[]): string | undefined {
	for (const target of targets) {
		if (!target.url.startsWith("chrome-extension://")) continue;
		try {
			return new URL(target.url).host;
		} catch {
			continue;
		}
	}
	return undefined;
}

async function openChatTarget(id: string): Promise<DebugTarget> {
	const url = `chrome-extension://${id}/${CHAT_PAGE}`;
	const response = await fetch(
		`http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURIComponent(url)}`,
		{ method: "PUT" },
	);
	if (!response.ok) {
		throw new Error(`could not open the chat page: HTTP ${response.status}`);
	}
	return (await response.json()) as DebugTarget;
}

type CdpMessage = {
	id?: number;
	method?: string;
	params?: Record<string, unknown>;
	result?: unknown;
	error?: { message: string };
};

function connectCdp(url: string): Promise<{
	send<T>(method: string, params?: Record<string, unknown>): Promise<T>;
	close(): void;
	events: CdpMessage[];
}> {
	const socket = new WebSocket(url);
	let nextId = 0;
	const events: CdpMessage[] = [];
	const pending = new Map<number, {
		resolve(value: unknown): void;
		reject(error: Error): void;
	}>();
	return new Promise((resolvePromise, reject) => {
		socket.addEventListener("error", () => reject(new Error("CDP socket failed")));
		socket.addEventListener("message", (event) => {
			const message = JSON.parse(String(event.data)) as CdpMessage;
			if (message.id === undefined) {
				events.push(message);
				if (events.length > 40) events.shift();
				return;
			}
			const waiter = pending.get(message.id);
			if (!waiter) return;
			pending.delete(message.id);
			if (message.error) waiter.reject(new Error(message.error.message));
			else waiter.resolve(message.result);
		});
		socket.addEventListener("open", () => {
			resolvePromise({
				send(method, params) {
					const id = ++nextId;
					return new Promise((resolveSend, rejectSend) => {
						pending.set(id, { resolve: resolveSend, reject: rejectSend });
						socket.send(JSON.stringify({ id, method, params }));
					});
				},
				close() {
					socket.close();
				},
				events,
			});
		});
	});
}

type PageProbe = {
	pill?: string;
	pairStatus?: string;
	pairHeading?: string;
};

function reportDrop(input: ConnectionDropInput): void {
	logConnectionDrop(input, (line) => console.error(line));
}

function consoleMessages(events: CdpMessage[]): DropMessage[] {
	const messages: DropMessage[] = [];
	for (const event of events) {
		if (event.method !== "Runtime.consoleAPICalled") continue;
		const args = event.params?.args;
		const type = event.params?.type;
		const text = Array.isArray(args)
			? args
					.map((arg) =>
						typeof arg === "object" && arg !== null && "value" in arg
							? String((arg as { value?: unknown }).value)
							: "",
					)
					.join(" ")
			: "";
		messages.push({
			direction: "in",
			type: typeof type === "string" ? `console.${type}` : "console",
			at: new Date().toISOString(),
			summary: text,
		});
	}
	return messages.slice(-8);
}

async function probeChat(cdp: {
	send<T>(method: string, params?: Record<string, unknown>): Promise<T>;
}): Promise<PageProbe> {
	const result = await cdp.send<{ result?: { value?: PageProbe } }>(
		"Runtime.evaluate",
		{
			expression: `({
				pill: document.querySelector(".chat-rail__connection")?.textContent ?? "",
				pairStatus: document.querySelector(".pair-panel__status")?.textContent ?? "",
				pairHeading: document.querySelector(".pair-panel__title, .sec-h")?.textContent ?? ""
			})`,
			returnByValue: true,
		},
	);
	return result.result?.value ?? {};
}

function pageShowsDrop(probe: PageProbe): boolean {
	const text = `${probe.pill ?? ""} ${probe.pairStatus ?? ""}`;
	return /unreachable|not confirmed|could not|rejected|disconnected|expired/i.test(
		text,
	);
}

async function captureChat(pngPath: string): Promise<void> {
	const expectedId = extensionIdFromPath(EXTENSION_DIR);
	let targets = await waitForTargets();
	const deadline = Date.now() + 15_000;
	while (!targets.some((target) => target.url.includes(expectedId)) && Date.now() < deadline) {
		await Bun.sleep(300);
		targets = await waitForTargets(Date.now() + 2_000);
	}
	const id = targets.some((target) => target.url.includes(expectedId))
		? expectedId
		: extensionId(targets);
	if (!id) {
		reportDrop({
			phase: "extension-load",
			reason:
				"extension did not register a Chrome target. Branded Chrome ignores --load-extension; set DG_TEST_CHROME_BIN to Chrome for Testing.",
			serviceWorker: { active: false, lifecycle: "missing" },
			sidePanel: { open: false, lifecycle: "missing" },
			daemon: { reachable: false },
		});
		throw new Error(
			"extension did not register a Chrome target. Branded Chrome ignores --load-extension; set DG_TEST_CHROME_BIN to Chrome for Testing.",
		);
	}
	const page = await openChatTarget(id);
	if (!page.webSocketDebuggerUrl) {
		throw new Error("chat page has no debugger socket");
	}
	await Bun.sleep(600);
	const cdp = await connectCdp(page.webSocketDebuggerUrl);
	try {
		await cdp.send("Runtime.enable");
		await cdp.send("Page.enable");
		await cdp.send("Emulation.setDeviceMetricsOverride", {
			width: 420,
			height: 900,
			deviceScaleFactor: 1,
			mobile: false,
		});
		await cdp.send("Runtime.evaluate", {
			expression:
				"document.documentElement.style.width='420px'; document.body.style.width='420px'; true",
		});
		await Bun.sleep(400);
		const probe = await probeChat(cdp);
		const worker = targets.find(
			(target) => target.type === "service_worker" && target.url.includes(id),
		);
		if (pageShowsDrop(probe)) {
			reportDrop({
				phase: probe.pill?.includes("unreachable")
					? "daemon-discover"
					: "dropped",
				reason: `${probe.pairHeading ?? ""} ${probe.pill ?? ""} ${probe.pairStatus ?? ""}`.trim(),
				sidePanel: {
					open: true,
					url: page.url,
					lifecycle: probe.pairHeading || "open",
				},
				serviceWorker: {
					active: worker !== undefined,
					lifecycle: worker ? "running" : "missing",
				},
				lastMessages: consoleMessages(cdp.events),
				daemon: { reachable: !probe.pill?.includes("unreachable") },
			});
		}
		const shot = await cdp.send<{ data: string }>("Page.captureScreenshot", {
			format: "png",
		});
		mkdirSync(dirname(pngPath), { recursive: true });
		await Bun.write(pngPath, Buffer.from(shot.data, "base64"));
		console.log(`wrote ${pngPath}`);
		console.log(`extension ${id}`);
	} finally {
		cdp.close();
	}
}

function chromeBinary(): string {
	const candidates = [
		process.env.DG_TEST_CHROME_BIN,
		resolve(homedir(), ".dg", "chrome-for-testing", "chrome"),
		"/tmp/cft/chrome-linux64/chrome",
		"google-chrome",
	].filter((value): value is string => Boolean(value));
	return candidates.find((candidate) => candidate === "google-chrome" || existsSync(candidate)) ?? "google-chrome";
}

/** Unpacked extension ids are the SHA-256 of the absolute path, hex nibbles mapped to a–p. */
function extensionIdFromPath(extensionPath: string): string {
	const hash = createHash("sha256").update(extensionPath).digest();
	let id = "";
	for (const byte of hash.subarray(0, 16)) {
		id += String.fromCharCode(97 + (byte >> 4));
		id += String.fromCharCode(97 + (byte & 0xf));
	}
	return id;
}

function launchChrome(profile: string): ChildProcess {
	mkdirSync(profile, { recursive: true });
	const chrome = chromeBinary();
	console.log(`chrome: ${chrome}`);
	return spawn(
		chrome,
		[
			`--user-data-dir=${profile}`,
			`--disable-extensions-except=${EXTENSION_DIR}`,
			`--load-extension=${EXTENSION_DIR}`,
			`--remote-debugging-port=${DEBUG_PORT}`,
			"--disable-features=DisableLoadExtensionCommandLineSwitch",
			"--no-sandbox",
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-dev-shm-usage",
			"--window-size=440,920",
			"about:blank",
		],
		{ stdio: "ignore" },
	);
}

async function main(): Promise<void> {
	const flags = parseFlags(process.argv.slice(2));
	await ensureExtension(flags.skipBuild);
	if (flags.withDaemon) {
		startDaemon();
		console.log("dg-daemon starting (DG_HOME=" + (process.env.DG_HOME ?? resolve(homedir(), ".dg")) + ")");
	}
	const chrome = launchChrome(flags.profile);
	const stop = () => {
		if (!chrome.killed) chrome.kill();
	};
	process.on("SIGINT", () => {
		stop();
		process.exit(0);
	});
	process.on("SIGTERM", () => {
		stop();
		process.exit(0);
	});
	if (flags.screenshot) {
		try {
			await captureChat(flags.screenshot);
		} finally {
			stop();
		}
		return;
	}
	console.log(`test Chrome profile: ${flags.profile}`);
	console.log(`extension: ${EXTENSION_DIR}`);
	console.log("Quit Chrome to stop. The toolbar icon opens the chat side panel.");
	await new Promise<void>((resolvePromise) => {
		chrome.on("exit", () => resolvePromise());
	});
}

main().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	reportDrop({
		phase: "dropped",
		reason: message,
		sidePanel: { lifecycle: "unknown" },
		serviceWorker: { lifecycle: "unknown" },
	});
	logHarnessLine(message);
	process.exit(1);
});
