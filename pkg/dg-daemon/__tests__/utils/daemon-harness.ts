import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	ASSET_FILENAME_HEADER,
	CHAT_MARKER_KEY,
	CHAT_PROTOCOL_VERSION,
	CLI_SESSION_ID_HEADER,
	CLI_SESSION_TOKEN_HEADER,
	type DaemonHandle,
	type SessionBootstrap,
	type SessionRole,
	validateDaemonHandle,
	validateSessionBootstrap,
} from "@dg/common";
import {
	readAssetSourceFile,
	readSessionToken,
	resolveDgPaths,
} from "@dg/common/node";
import type { Subprocess } from "bun";

export { getConfiguredAssetDirectory } from "../../src/assets/config";
export { ChatStore } from "../../src/store";

export const ENTRY = join(import.meta.dir, "../../src/index.ts");

const PORT_SEARCH_BASE = 47500;
const PORT_SEARCH_SPAN = 2048;

let nextPort =
	PORT_SEARCH_BASE + (process.pid % 64) * Math.floor(PORT_SEARCH_SPAN / 64);

function isPortFree(port: number): boolean {
	try {
		const probe = Bun.serve({
			hostname: "127.0.0.1",
			port,
			fetch: () => new Response(""),
		});
		probe.stop(true);
		return true;
	} catch {
		return false;
	}
}

/** A port no live process holds; two test packages running at once must not collide. */
export function allocatePort(): number {
	for (let tried = 0; tried < PORT_SEARCH_SPAN; tried++) {
		const candidate =
			PORT_SEARCH_BASE + ((nextPort++ - PORT_SEARCH_BASE) % PORT_SEARCH_SPAN);
		if (isPortFree(candidate)) return candidate;
	}
	throw new Error("the test harness found no free port to allocate");
}

export function scratchDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), `${prefix}-test-`));
}

export function freshTempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

export function freshDgHome(): string {
	return scratchDir("dg-daemon");
}

export const FILE_ONLY_SEAMS = { env: { DG_KEY_SOURCE: "file" } };

export function scanFileForBytes(path: string, needle: string): boolean {
	if (!existsSync(path)) return false;
	return readFileSync(path).includes(Buffer.from(needle, "utf8"));
}

export function findFileContaining(dir: string, needle: Buffer): boolean {
	if (!existsSync(dir)) return false;
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const stat = statSync(full);
		if (stat.isDirectory()) {
			if (findFileContaining(full, needle)) return true;
		} else if (readFileSync(full).includes(needle)) {
			return true;
		}
	}
	return false;
}

export function writeJsonFile(
	dir: string,
	name: string,
	contents: unknown,
): string {
	const path = join(dir, name);
	writeFileSync(path, JSON.stringify(contents));
	return path;
}

export function cleanupDgHome(dgHome: string): void {
	rmSync(dgHome, { recursive: true, force: true });
}

export function subprocessEnv(
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
	env.DG_KEY_SOURCE = "file";
	Object.assign(env, extraEnv);
	return env;
}

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

export type ServeBoot = {
	dgHome: string;
	port: number;
	proc: ReturnType<typeof spawnServe>;
};

export async function bootServe(
	extraEnv: Record<string, string> = {},
): Promise<ServeBoot> {
	const dgHome = freshDgHome();
	const port = allocatePort();
	const proc = spawnServe(dgHome, port, extraEnv);
	await waitForHealth(port);
	return { dgHome, port, proc };
}

export type CleanupSlot = {
	set(fn: () => Promise<void>): void;
	run(): Promise<void>;
};

export function createCleanupSlot(): CleanupSlot {
	let cleanup: (() => Promise<void>) | undefined;
	return {
		set(fn) {
			cleanup = fn;
		},
		async run() {
			await cleanup?.();
			cleanup = undefined;
		},
	};
}

export type StartResult = { stdout: string; stderr: string; exitCode: number };

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
	timeoutMs = 3000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			const resp = await fetch(`http://127.0.0.1:${port}/healthz`, {
				headers: { Host: `127.0.0.1:${port}` },
			});
			if (resp.ok) return;
			lastError = new Error(`/healthz responded ${resp.status}`);
		} catch (err) {
			lastError = err;
		}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(
		`daemon on port ${port} never became healthy: ${String(lastError)}`,
	);
}

export function readDaemonLog(dgHome: string): string {
	const { logDir } = resolveDgPaths({ env: { DG_HOME: dgHome } });
	if (!existsSync(logDir)) return "";
	return readdirSync(logDir)
		.filter((name) => name.endsWith(".log"))
		.map((name) => readFileSync(join(logDir, name), "utf8"))
		.join("");
}

export function readPidFile(dgHome: string): DaemonHandle {
	const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
	const raw = JSON.parse(readFileSync(paths.pidPath, "utf8"));
	return validateDaemonHandle(raw);
}

export async function waitForPidFile(
	dgHome: string,
	timeoutMs = 5000,
): Promise<DaemonHandle> {
	const deadline = Date.now() + timeoutMs;
	let lastErr: unknown;
	while (Date.now() < deadline) {
		try {
			return readPidFile(dgHome);
		} catch (err) {
			lastErr = err;
		}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(
		`pid file never appeared under ${dgHome}: ${String(lastErr)}`,
	);
}

export function killDaemonByPidFile(dgHome: string): void {
	try {
		const handle = readPidFile(dgHome);
		process.kill(handle.pid, "SIGTERM");
	} catch {}
}

export async function stopServe(proc: Subprocess): Promise<void> {
	proc.kill();
	await proc.exited;
}

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

export type SessionBoot = {
	dgHome: string;
	port: number;
	bootstrap: SessionBootstrap;
};

export type RegisterSessionInput = {
	cwd?: string;
	role?: SessionRole;
	workset?: string;
	agentIdentity?: string;
};

export async function registerSession(
	port: number,
	input: RegisterSessionInput = {},
): Promise<SessionBootstrap> {
	const resp = await fetch(`http://127.0.0.1:${port}/start`, {
		method: "POST",
		headers: {
			Host: `127.0.0.1:${port}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			cwd: input.cwd ?? process.cwd(),
			role: input.role ?? "agent",
			...(input.workset ? { workset: input.workset } : {}),
			...(input.agentIdentity ? { agentIdentity: input.agentIdentity } : {}),
		}),
	});
	if (!resp.ok) {
		throw new Error(
			`session registration failed: ${resp.status} ${await resp.text()}`,
		);
	}
	return validateSessionBootstrap(await resp.json());
}

export async function startWithSession(
	extraEnv: Record<string, string> = {},
): Promise<SessionBoot> {
	const dgHome = freshDgHome();
	const port = allocatePort();
	spawnServe(dgHome, port, extraEnv);
	await waitForHealth(port);
	const bootstrap = await registerSession(port);
	return { dgHome, port, bootstrap };
}

export function sessionCredentials(
	dgHome: string,
	sessionId: string,
): Credentials {
	const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
	return { sessionId, token: readSessionToken(paths, sessionId) };
}

export async function spawnSession(
	dgHome: string,
	port: number,
	sessionId: string,
	opts: {
		workset?: string;
		agentIdentity?: string;
		orchestrator?: boolean;
	} = {},
): Promise<Credentials> {
	const credentials = sessionCredentials(dgHome, sessionId);
	const ws = await connectCli(port, credentials);
	const frames = collectFrames(ws);
	send(ws, {
		type: "session-create",
		sessionId: credentials.sessionId,
		token: credentials.token,
		role: opts.orchestrator ? "orchestrator" : "agent",
		...(opts.workset ? { workset: opts.workset } : {}),
		...(opts.agentIdentity ? { agentIdentity: opts.agentIdentity } : {}),
	});
	const pending = await waitForValue(
		() => frames.find((f) => frameType(f) === "session-pending"),
		5000,
		"a session-pending response to session-create",
	);
	ws.close();
	return (pending as { newSession: Credentials }).newSession;
}

export async function closeSession(
	dgHome: string,
	port: number,
	sessionId: string,
): Promise<void> {
	const credentials = sessionCredentials(dgHome, sessionId);
	const ws = await connectCli(port, credentials);
	const frames = collectFrames(ws);
	send(ws, {
		type: "session-close",
		sessionId: credentials.sessionId,
		token: credentials.token,
	});
	await waitForValue(
		() => frames.find((f) => frameType(f) === "session-closed"),
		5000,
		"a session-closed response to session-close",
	);
	ws.close();
}

export type RecvOutcome = {
	outcome: "delivered" | "empty" | "timeout" | "closed";
	message?: Record<string, unknown>;
};

export async function recvMessage(
	dgHome: string,
	port: number,
	sessionId: string,
	opts: { block?: boolean; timeoutMs?: number } = {},
): Promise<RecvOutcome> {
	const credentials = sessionCredentials(dgHome, sessionId);
	const timeoutMs = opts.timeoutMs ?? 30_000;
	const ws = await connectCli(port, credentials);
	const frames = collectFrames(ws);
	send(ws, {
		type: "cli-recv",
		block: opts.block ?? false,
		...(opts.block ? { timeoutMs } : {}),
	});
	const result = (await waitForValue(
		() => frames.find((f) => frameType(f) === "cli-recv-result"),
		timeoutMs + 2000,
		"a cli-recv-result response",
	)) as RecvOutcome;
	if (result.outcome === "delivered" && result.message) {
		send(ws, { type: "cli-ack", claimId: result.message.claimId as string });
	}
	ws.close();
	return result;
}

export async function stageAsset(
	dgHome: string,
	port: number,
	sessionId: string,
	sourcePath: string,
): Promise<string> {
	const credentials = sessionCredentials(dgHome, sessionId);
	const filename = basename(sourcePath);
	const bytes = readAssetSourceFile(sourcePath);
	const resp = await fetch(`http://127.0.0.1:${port}/assets`, {
		method: "POST",
		headers: {
			Host: `127.0.0.1:${port}`,
			[CLI_SESSION_ID_HEADER]: credentials.sessionId,
			[CLI_SESSION_TOKEN_HEADER]: credentials.token,
			[ASSET_FILENAME_HEADER]: encodeURIComponent(filename),
		},
		body: new Uint8Array(
			bytes.buffer as ArrayBuffer,
			bytes.byteOffset,
			bytes.byteLength,
		),
	});
	if (!resp.ok) throw new Error(await resp.text());
	const result = (await resp.json()) as { assetId: string };
	return result.assetId;
}

export function wsUrl(port: number, path: "/ws" | "/cli"): string {
	return `ws://127.0.0.1:${port}${path}`;
}

type BunWebSocketCtor = new (
	url: string,
	options?: Bun.WebSocketOptions,
) => WebSocket;
const BunWebSocket = WebSocket as unknown as BunWebSocketCtor;

export type Credentials = { sessionId: string; token: string };

export function cliSocket(port: number, credentials: Credentials): WebSocket {
	return new BunWebSocket(wsUrl(port, "/cli"), {
		headers: {
			[CLI_SESSION_ID_HEADER]: credentials.sessionId,
			[CLI_SESSION_TOKEN_HEADER]: credentials.token,
		},
	});
}

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

export function wsExtensionSocket(port: number): WebSocket {
	return new BunWebSocket(wsUrl(port, "/ws"), {
		headers: { Origin: EXTENSION_ORIGIN },
	});
}

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

export function frameType(f: unknown): string | undefined {
	return (f as { type?: string }).type;
}

export function send(ws: WebSocket, frame: Record<string, unknown>): void {
	ws.send(JSON.stringify({ protocolVersion: CHAT_PROTOCOL_VERSION, ...frame }));
}

export async function connectPage(
	port: number,
	credentials: Credentials,
	protocolVersion: number = CHAT_PROTOCOL_VERSION,
): Promise<WebSocket> {
	const page = wsExtensionSocket(port);
	await waitForOpen(page);
	sendConnectHandshake(page, credentials, protocolVersion);
	await new Promise((r) => setTimeout(r, 100));
	return page;
}

export function closeSockets(sockets: WebSocket[]): void {
	for (const socket of sockets) socket.close();
	sockets.length = 0;
}

export async function deliverUserMessage(
	port: number,
	credentials: Credentials,
	body: string,
): Promise<void> {
	const page = await connectPage(port, credentials);
	page.send(
		JSON.stringify({
			type: "user-message",
			sessionId: credentials.sessionId,
			token: credentials.token,
			protocolVersion: CHAT_PROTOCOL_VERSION,
			messageId: randomUUID(),
			body,
		}),
	);
	await new Promise((r) => setTimeout(r, 150));
	page.close();
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
