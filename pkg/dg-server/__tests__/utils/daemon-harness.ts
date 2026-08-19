/**
 * Subprocess harness: drives the real entry point via DG_HOME/DG_PORT seams.
 * Most tests spawn the ratified hidden `__serve` subcommand directly (bypassing `start`'s detach/re-exec dance); only the two contracts naming `start` drive it itself.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DaemonHandle, validateDaemonHandle } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import type { Subprocess } from "bun";

const ENTRY = join(import.meta.dir, "../../src/index.ts");

// Private test-only range: never the real published default, so a run here
// can never collide with (or accidentally exercise) a developer's live daemon.
let nextPort = 47500;
export function allocatePort(): number {
	return nextPort++;
}

export function freshDgHome(): string {
	return mkdtempSync(join(tmpdir(), "dg-server-test-"));
}

export function cleanupDgHome(dgHome: string): void {
	rmSync(dgHome, { recursive: true, force: true });
}

function subprocessEnv(
	dgHome: string,
	port: number,
	extraEnv: Record<string, string> = {},
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (v !== undefined) env[k] = v;
	}
	env.DG_HOME = dgHome;
	env.DG_PORT = String(port);
	// Default to the file key source so a subprocess test never probes or
	// writes the developer's real OS keychain (this box has a working one).
	env.DG_KEY_SOURCE = "file";
	Object.assign(env, extraEnv);
	return env;
}

/**
 * Foreground the actual HTTP+WS server — no daemonize/detach indirection.
 * No explicit return type: annotating it as bare `Subprocess` would widen
 * stdout/stderr away from the "pipe" literal actually passed below, losing
 * their real ReadableStream type for callers that read them directly.
 */
export function spawnServe(
	dgHome: string,
	port: number,
	extraEnv: Record<string, string> = {},
) {
	return Bun.spawn([process.execPath, ENTRY, "__serve"], {
		env: subprocessEnv(dgHome, port, extraEnv),
		stdout: "pipe",
		stderr: "pipe",
	});
}

export type StartResult = { stdout: string; stderr: string; exitCode: number };

/** Run the public `start` verb to completion; it daemonizes and exits quickly. */
export async function runStart(
	dgHome: string,
	port: number,
	extraEnv: Record<string, string> = {},
): Promise<StartResult> {
	const proc = Bun.spawn([process.execPath, ENTRY, "start"], {
		env: subprocessEnv(dgHome, port, extraEnv),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

/** Run the public `status` verb to completion. */
export async function runStatus(
	dgHome: string,
	extraEnv: Record<string, string> = {},
): Promise<StartResult> {
	const proc = Bun.spawn([process.execPath, ENTRY, "status"], {
		env: subprocessEnv(dgHome, 0, extraEnv),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

export async function waitForHealth(
	port: number,
	timeoutMs = 5000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			const resp = await fetch(`http://127.0.0.1:${port}/health`, {
				headers: { Host: `127.0.0.1:${port}` },
			});
			if (resp.ok) return;
			lastError = new Error(`/health responded ${resp.status}`);
		} catch (err) {
			lastError = err;
		}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(
		`daemon on port ${port} never became healthy: ${String(lastError)}`,
	);
}

export function readLockfile(dgHome: string): DaemonHandle {
	const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
	const raw = JSON.parse(readFileSync(paths.lockfilePath, "utf8"));
	return validateDaemonHandle(raw);
}

export async function waitForLockfile(
	dgHome: string,
	timeoutMs = 5000,
): Promise<DaemonHandle> {
	const deadline = Date.now() + timeoutMs;
	let lastErr: unknown;
	while (Date.now() < deadline) {
		try {
			return readLockfile(dgHome);
		} catch (err) {
			lastErr = err;
		}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(
		`lockfile never appeared under ${dgHome}: ${String(lastErr)}`,
	);
}

/** Best-effort kill of a `start`-daemonized process, located via its lockfile pid. */
export function killDaemonByLockfile(dgHome: string): void {
	try {
		const handle = readLockfile(dgHome);
		process.kill(handle.pid, "SIGTERM");
	} catch {
		// already gone, or a lockfile was never written — nothing to clean up.
	}
}

export async function stopServe(proc: Subprocess): Promise<void> {
	proc.kill();
	await proc.exited;
}

// --- Bootstrap marker decoding ----------------------------------------------
// Ratified: base64url(JSON) in the fragment under the "_chat" key, no compression.
export const CHAT_MARKER_KEY = "_chat";

export function extractUrl(stdout: string): string {
	const match = stdout.match(/https?:\/\/\S+/);
	if (!match) {
		throw new Error(`no URL found in stdout: ${JSON.stringify(stdout)}`);
	}
	return match[0];
}

export function decodeChatMarker(url: string): unknown {
	const hashIndex = url.indexOf("#");
	if (hashIndex < 0) throw new Error(`URL carries no fragment: ${url}`);
	const fragment = url.slice(hashIndex + 1);
	const entry = fragment
		.split("&")
		.find((part) => part.startsWith(`${CHAT_MARKER_KEY}=`));
	if (!entry) {
		throw new Error(
			`fragment carries no ${CHAT_MARKER_KEY} marker: ${fragment}`,
		);
	}
	const encoded = entry.slice(CHAT_MARKER_KEY.length + 1);
	const json = Buffer.from(encoded, "base64url").toString("utf8");
	return JSON.parse(json);
}

// Capability capture is a post-connect handshake frame on /ws, a request
// header on /cli — never a query string (Code Structure's transport ratification).
export function wsUrl(port: number, path: "/ws" | "/cli"): string {
	return `ws://127.0.0.1:${port}${path}`;
}

// lib.dom's WebSocket overload beats Bun's headers-carrying one under this
// tsconfig (no explicit `lib`) — verified empirically. Cast through a typed ctor, not `any`.
type BunWebSocketCtor = new (
	url: string,
	options?: Bun.WebSocketOptions,
) => WebSocket;
const BunWebSocket = WebSocket as unknown as BunWebSocketCtor;

export const CLI_SESSION_ID_HEADER = "X-Dg-Session-Id";
export const CLI_SESSION_TOKEN_HEADER = "X-Dg-Session-Token";

export type Credentials = { sessionId: string; token: string };

/** Raw (un-awaited) /cli socket, headers carrying the capability pair — for tests expecting the upgrade itself to fail. */
export function cliSocket(port: number, credentials: Credentials): WebSocket {
	return new BunWebSocket(wsUrl(port, "/cli"), {
		headers: {
			[CLI_SESSION_ID_HEADER]: credentials.sessionId,
			[CLI_SESSION_TOKEN_HEADER]: credentials.token,
		},
	});
}

/** Open a /cli connection and wait for it to complete — the header pair authenticates at upgrade time. */
export async function connectCli(
	port: number,
	credentials: Credentials,
): Promise<WebSocket> {
	const ws = cliSocket(port, credentials);
	await waitForOpen(ws);
	return ws;
}

export const EXTENSION_ORIGIN =
	"chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const BROWSER_ORIGIN = "https://evil.example";

/** Raw (un-awaited) /ws socket with a valid extension-scheme Origin — capability capture happens afterward via a connect handshake frame, see sendConnectHandshake. */
export function wsExtensionSocket(port: number): WebSocket {
	return new BunWebSocket(wsUrl(port, "/ws"), {
		headers: { Origin: EXTENSION_ORIGIN },
	});
}

// [SPEC] ASSUMED: Code Structure names only "a connect handshake" (plan.md
// 280, 875), not a wire shape — `type: "connect"` (deliberately outside the 18 ratified ChatFrame types, which all assume capability already exists) is the most reasonable reading.
export function sendConnectHandshake(
	ws: WebSocket,
	credentials: Credentials,
	protocolVersion: number,
): void {
	ws.send(
		JSON.stringify({
			type: "connect",
			sessionId: credentials.sessionId,
			token: credentials.token,
			protocolVersion,
		}),
	);
}

export function waitForOpen(ws: WebSocket, timeoutMs = 3000): Promise<void> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(
			() => reject(new Error("WebSocket did not open in time")),
			timeoutMs,
		);
		ws.addEventListener(
			"open",
			() => {
				clearTimeout(t);
				resolve();
			},
			{ once: true },
		);
		ws.addEventListener(
			"error",
			() => {
				clearTimeout(t);
				reject(new Error("WebSocket errored before opening"));
			},
			{ once: true },
		);
	});
}

export type ClosedInfo = { code: number; reason: string };

export function waitForClose(
	ws: WebSocket,
	timeoutMs = 3000,
): Promise<ClosedInfo> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(
			() => reject(new Error("WebSocket did not close in time")),
			timeoutMs,
		);
		ws.addEventListener(
			"close",
			(ev) => {
				clearTimeout(t);
				const closeEvent = ev as CloseEvent;
				resolve({ code: closeEvent.code, reason: closeEvent.reason });
			},
			{ once: true },
		);
	});
}

/** Collects every JSON-parseable message frame received on `ws` into an array. */
export function collectFrames(ws: WebSocket): unknown[] {
	const frames: unknown[] = [];
	ws.addEventListener("message", (ev) => {
		try {
			frames.push(JSON.parse(ev.data as string));
		} catch {
			frames.push(ev.data);
		}
	});
	return frames;
}

/** Poll `check` until it returns a defined value, or throw after `timeoutMs`. */
export async function waitForValue<T>(
	check: () => T | undefined,
	timeoutMs = 3000,
	label = "condition",
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const v = check();
		if (v !== undefined) return v;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`timed out waiting for ${label}`);
}
