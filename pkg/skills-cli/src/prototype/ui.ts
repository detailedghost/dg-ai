import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { scratchDir, selfCommand, tryOpen } from "@dg/common/node";
import { type Flags, parseFlags } from "./args";
import { parseManifestSource, render } from "./manifest";
import { protoDir, sentinelPaths } from "./paths";
import { status, type WaitResult, wait } from "./sentinels";

const SERVER_START_MS = 10_000;
const STALE_SENTINELS = [".selection", ".reject", ".notes", ".decision"];
const BOUND_LINE = /^prototype-serve: http:\/\/127\.0\.0\.1:(\d+)\//;

export interface UiState {
	name: string;
	cwd: string;
	sentinelDir: string;
	htmlPath: string;
	pid: number;
	port: number;
	light: boolean;
	series?: boolean;
}

function stateDirectory(): string {
	return scratchDir("prototype-ui", { cwdScope: false });
}

function pinCwd(): string {
	return join(stateDirectory(), "_cwd");
}

function statePathFor(name: string): string {
	return join(stateDirectory(), `${name}.json`);
}

/** Load the recorded session for a chain key; wait, status and stop read this instead of the ambient cwd. */
export function loadState(name: string): UiState | undefined {
	try {
		return JSON.parse(readFileSync(statePathFor(name), "utf8")) as UiState;
	} catch {
		return undefined;
	}
}

function saveState(state: UiState): void {
	mkdirSync(stateDirectory(), { recursive: true });
	writeFileSync(
		statePathFor(state.name),
		`${JSON.stringify(state, null, 2)}\n`,
	);
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function clearSentinels(dir: string): void {
	for (const name of STALE_SENTINELS) rmSync(join(dir, name), { force: true });
}

function bumpReloadToken(dir: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(sentinelPaths(dir).reload, `${Date.now()}\n`);
}

async function launchServer(
	htmlPath: string,
	name: string,
	state: Pick<UiState, "cwd" | "sentinelDir" | "light">,
	port: number,
	idleSec: number,
): Promise<{ pid: number; port: number }> {
	const proc = Bun.spawn({
		cmd: selfCommand([
			"prototype",
			"serve",
			htmlPath,
			name,
			`--port=${port}`,
			`--idle=${idleSec}`,
			`--dir=${state.sentinelDir}`,
			...(state.light ? ["--light"] : []),
		]),
		cwd: state.cwd,
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
		const newline = buffer.indexOf("\n");
		if (newline === -1) continue;
		const match = BOUND_LINE.exec(buffer.slice(0, newline));
		if (match) bound = Number(match[1]);
		buffer = buffer.slice(newline + 1);
	}
	reader.releaseLock();
	if (bound === undefined) {
		proc.kill();
		throw new Error("prototype serve did not report a bound port within 10s");
	}
	proc.unref();
	return { pid: proc.pid, port: bound };
}

function terminate(pid: number): void {
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		return;
	}
}

function stopSession(state: UiState): void {
	if (isPidAlive(state.pid)) terminate(state.pid);
	for (const path of [statePathFor(state.name), state.htmlPath])
		rmSync(path, { force: true });
	clearSentinels(state.sentinelDir);
}

function finish(result: WaitResult, state: UiState): number {
	process.stdout.write(`${JSON.stringify(result)}\n`);
	if (result.status === "ok" && result.notes === "" && !state.series)
		stopSession(state);
	return result.status === "timeout" ? 1 : 0;
}

/** Claim a session's decision as one JSON line, from the sentinel directory recorded when it started. */
export async function waitSession(
	state: UiState,
	timeoutSec: number,
): Promise<number> {
	return finish(
		await wait(sentinelPaths(state.sentinelDir), timeoutSec),
		state,
	);
}

/** Render a manifest or ProtoPlan, serve it on one chain-keyed server and tab, and block for the decision. */
export async function runUi(argv: string[]): Promise<number> {
	const flags = parseFlags(argv, [
		"--chain",
		"--series",
		"--light",
		"--port",
		"--timeout",
		"--no-open",
	]);
	const source = flags.rest[0];
	if (!source) throw new Error("ui requires <manifest-file|->");
	const manifest = parseManifestSource(
		source === "-" ? readFileSync(0, "utf8") : readFileSync(source, "utf8"),
	);
	const rendered = render(manifest);
	const html = flags.series
		? rendered.replace(
				"<head>",
				"<head>\n<script>window.__protoSeries=true</script>",
			)
		: rendered;
	const key = flags.chain ?? manifest.chain;

	const existing = loadState(key);
	let state: UiState;
	if (existing && isPidAlive(existing.pid)) {
		clearSentinels(existing.sentinelDir);
		writeFileSync(existing.htmlPath, html);
		bumpReloadToken(existing.sentinelDir);
		state = { ...existing, series: flags.series };
		saveState(state);
	} else {
		state = await startSession(key, html, flags);
	}
	return waitSession(state, flags.timeoutSec);
}

async function startSession(
	key: string,
	html: string,
	flags: Flags,
): Promise<UiState> {
	const cwd = pinCwd();
	mkdirSync(cwd, { recursive: true });
	const htmlPath = join(stateDirectory(), `${key}.html`);
	writeFileSync(htmlPath, html);
	const sentinelDir = protoDir(key, { cwd, light: flags.light });
	clearSentinels(sentinelDir);
	bumpReloadToken(sentinelDir);
	const { pid, port } = await launchServer(
		htmlPath,
		key,
		{ cwd, sentinelDir, light: flags.light },
		flags.port,
		flags.timeoutSec,
	);
	const state: UiState = {
		name: key,
		cwd,
		sentinelDir,
		htmlPath,
		pid,
		port,
		light: flags.light,
		series: flags.series,
	};
	saveState(state);
	if (!flags.noOpen && !(await tryOpen(`http://127.0.0.1:${port}/`)))
		process.stderr.write(
			"prototype: warning: failed to auto-open the browser (continuing anyway)\n",
		);
	return state;
}

export function statusSession(state: UiState): string {
	return status(sentinelPaths(state.sentinelDir));
}

/** Stop a session's server and drop its state; stopping an unknown chain is a no-op. */
export function stopChain(name: string): string {
	const state = loadState(name);
	if (state) stopSession(state);
	return `${JSON.stringify({ status: "stopped", chain: name, found: state !== undefined })}\n`;
}

export function openInBrowser(target: string): Promise<boolean> {
	if (/^https?:\/\//.test(target) || !existsSync(target))
		return tryOpen(target);
	const converted = spawnSync("wslpath", ["-w", target], { encoding: "utf8" });
	return tryOpen(converted.status === 0 ? converted.stdout.trim() : target);
}
