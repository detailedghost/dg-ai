/**
 * `prototype ui`: token-light wrapper around the self-contained UI-variants
 * flow (render a manifest, self-dispatch `prototype serve`, open the
 * browser, block for a decision).
 *
 * Root-cause guard: the `--light` sentinel directory is scoped by a hash of
 * the launching cwd (see paths.ts). A harness that resets cwd between tool
 * calls would make a fresh `prototype selection wait` resolve a different
 * directory than the one `prototype serve` is writing into. Fix: pin every
 * path resolution this command makes to ONE fixed absolute cwd (`pinCwd()`),
 * recorded once per session in a state file and replayed on every later
 * call — never re-derived from ambient `process.cwd()`.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { scratchDir, selfCommand, tryOpen } from "@dg/common/node";
import { parseManifest, renderManifest } from "./manifest";
import { reloadPath } from "./paths";
import { type SelectionResult, selectionStatus, waitForSelection } from "./sentinel";

function stateDir(): string {
	return scratchDir("prototype-ui", { cwdScope: false });
}

function pinCwd(): string {
	return join(stateDir(), "_cwd");
}

const DEFAULT_PORT = 4321;
const DEFAULT_TIMEOUT_SEC = 900;
const OPEN_TIMEOUT_MS = 5_000;

interface UiState {
	name: string;
	cwd: string;
	htmlPath: string;
	pid: number;
	port: number;
	light: boolean;
}

function statePathFor(name: string): string {
	return join(stateDir(), `${name}.json`);
}

function loadState(name: string): UiState | null {
	const path = statePathFor(name);
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as UiState;
	} catch {
		return null;
	}
}

function saveState(state: UiState): void {
	mkdirSync(stateDir(), { recursive: true });
	writeFileSync(statePathFor(state.name), `${JSON.stringify(state, null, 2)}\n`);
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function launchServer(
	htmlPath: string,
	name: string,
	light: boolean,
	port: number,
	cwd: string,
): Promise<{ pid: number; port: number }> {
	const args = ["prototype", "serve", htmlPath, name, ...(light ? ["--light"] : []), `--port=${port}`];
	const proc = Bun.spawn({
		cmd: selfCommand(args),
		cwd,
		stdout: "pipe",
		stderr: "ignore",
		stdin: "ignore",
	});

	const reader = proc.stdout.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	let boundPort: number | null = null;
	const deadline = Date.now() + 10_000;

	while (boundPort === null && Date.now() < deadline) {
		const { value, done } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });
		const newline = buf.indexOf("\n");
		if (newline === -1) continue;
		const line = buf.slice(0, newline);
		const match = line.match(/^prototype-serve: http:\/\/127\.0\.0\.1:(\d+)\//);
		if (match) boundPort = Number(match[1]);
		buf = buf.slice(newline + 1);
	}
	reader.releaseLock();

	if (boundPort === null) {
		throw new Error("prototype ui: prototype serve did not report a bound port within 10s");
	}
	proc.unref();
	return { pid: proc.pid, port: boundPort };
}

export interface RunUiOptions {
	light: boolean;
	port: number;
	timeoutSec: number;
	noOpen: boolean;
}

export async function runUi(manifestSource: string, opts: RunUiOptions): Promise<SelectionResult> {
	const raw =
		manifestSource === "-" ? readFileSync(0, "utf8") : readFileSync(manifestSource, "utf8");
	const local = parseManifest(raw);
	const html = renderManifest(local);

	const existing = loadState(local.plan.slug);
	let state: UiState;

	if (existing && isPidAlive(existing.pid)) {
		// Rework loop: reuse the running server, push new content, bump the
		// reload token. Never re-derive cwd — replay what's recorded.
		writeFileSync(existing.htmlPath, html);
		const path = await reloadPath(local.plan.slug, { light: existing.light, cwd: existing.cwd });
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${Date.now()}\n`);
		state = existing;
	} else {
		mkdirSync(pinCwd(), { recursive: true });
		const htmlPath = join(stateDir(), `${local.plan.slug}.html`);
		writeFileSync(htmlPath, html);

		const { pid, port } = await launchServer(htmlPath, local.plan.slug, opts.light, opts.port, pinCwd());

		state = { name: local.plan.slug, cwd: pinCwd(), htmlPath, pid, port, light: opts.light };
		saveState(state);

		if (!opts.noOpen) {
			try {
				await Promise.race([
					tryOpen(`http://127.0.0.1:${port}/`),
					new Promise((resolve) => setTimeout(resolve, OPEN_TIMEOUT_MS)),
				]);
			} catch (err) {
				process.stderr.write(
					`prototype ui: warning: failed to auto-open the browser (continuing anyway): ${err instanceof Error ? err.message : String(err)}\n`,
				);
			}
		}
	}

	const result = await waitForSelection(local.plan.slug, {
		light: state.light,
		cwd: state.cwd,
		timeoutMs: opts.timeoutSec * 1000,
	});
	maybeTeardown(result, state);
	return result;
}

// Approve-with-no-notes ends the session: kill the server and drop its state
// so nothing lingers. Reject/approve-with-notes/timeout keep it running for
// the rework or reload loop the browser side is still watching.
function maybeTeardown(result: SelectionResult, state: UiState): void {
	if (result.status !== "ok" || result.notes !== "") return;
	if (isPidAlive(state.pid)) {
		try {
			process.kill(state.pid, "SIGTERM");
		} catch {
			// already gone
		}
	}
	for (const path of [statePathFor(state.name), state.htmlPath]) {
		try {
			rmSync(path);
		} catch {
			// best-effort cleanup
		}
	}
}

export class NoUiSessionError extends Error {
	constructor(readonly name: string) {
		super(`no session found for "${name}" — run \`prototype ui <manifest>\` first`);
	}
}

function requireState(name: string): UiState {
	const state = loadState(name);
	if (!state) throw new NoUiSessionError(name);
	return state;
}

export async function waitUi(name: string, timeoutSec: number): Promise<SelectionResult> {
	const state = requireState(name);
	const result = await waitForSelection(name, {
		light: state.light,
		cwd: state.cwd,
		timeoutMs: timeoutSec * 1000,
	});
	maybeTeardown(result, state);
	return result;
}

export async function statusUi(name: string): Promise<string> {
	const state = requireState(name);
	return selectionStatus(name, { light: state.light, cwd: state.cwd });
}

export const UI_DEFAULTS = {
	port: DEFAULT_PORT,
	timeoutSec: DEFAULT_TIMEOUT_SEC,
};
