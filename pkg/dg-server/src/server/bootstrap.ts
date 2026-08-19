import { spawn } from "node:child_process";
import {
	CHAT_PROTOCOL_VERSION,
	type SessionRole,
	validateSessionBootstrap,
} from "@dg/common";
import type { DgPaths } from "@dg/common/node";
import { resolveDgPaths } from "@dg/common/node";
import { type CloseReason, SessionRegistry } from "../session/registry";
import { buildBootstrapUrl } from "../utils/marker";
import { ConnectionManager, sendViaQueue } from "./connection";
import {
	DgCliError,
	EXIT_GENERAL_FAILURE,
	EXIT_NO_PORT_AVAILABLE,
	EXIT_PROTOCOL_MISMATCH,
} from "./errors";
import { createHttpServer, type HttpServerDeps, newInstanceId } from "./http";
import { createIdleController, DEFAULT_IDLE_TTL_MS } from "./idle-ttl";
import {
	isDaemonLive,
	readLockfile,
	removeLockfile,
	writeLockfileAtomic,
} from "./lockfile";
import { createLogger } from "./log";
import { candidatePorts } from "./ports";
import { DG_SERVER_PACKAGE_VERSION } from "./status";
import { checkWslNetworking } from "./wsl-guard";

const HOST_HEADER = (port: number) => ({ Host: `127.0.0.1:${port}` });

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A `bun build --compile` binary rewrites argv[1] to its own embedded
 * "/$bunfs/root/<name>" path regardless of invocation (confirmed empirically)
 * — that's not a re-exec arg. Dev mode's argv[1] is the real script path and
 * must be repeated so the child resolves the same entry module.
 */
function reExecPrefix(): string[] {
	const arg1 = process.argv[1];
	return arg1 !== undefined && !arg1.startsWith("/$bunfs/") ? [arg1] : [];
}

/** Re-exec self on the hidden __serve subcommand: detached, stdio ignored, unref'd. */
function spawnDaemonProcess(): void {
	const child = spawn(process.execPath, [...reExecPrefix(), "__serve"], {
		detached: true,
		stdio: "ignore",
		windowsHide: process.platform === "win32",
		env: process.env,
	});
	child.unref();
}

async function waitForFreshDaemon(paths: DgPaths, timeoutMs = 15000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const handle = readLockfile(paths);
		if (handle && (await isDaemonLive(handle))) return handle;
		await sleep(100);
	}
	throw new DgCliError(
		"dg-server did not become healthy within the startup timeout",
		EXIT_GENERAL_FAILURE,
	);
}

/**
 * A bind-conflict winner's own lockfile write can lag its successful bind by a
 * few ms (writeLockfileAtomic runs several sync statements later, un-awaited)
 * — settle briefly so a losing racer never mistakes that lag for "no live
 * daemon" and clobbers the winner's lockfile by binding a fallback port itself.
 */
async function awaitBindRival(
	paths: DgPaths,
	budgetMs = 500,
	pollMs = 20,
): Promise<ReturnType<typeof readLockfile>> {
	const deadline = Date.now() + budgetMs;
	for (;;) {
		const handle = readLockfile(paths);
		if (handle && (await isDaemonLive(handle))) return handle;
		if (Date.now() >= deadline) return undefined;
		await sleep(pollMs);
	}
}

type RegisterInput = {
	cwd: string;
	role: SessionRole;
	workset?: string;
	agentIdentity?: string;
};

async function registerSession(port: number, input: RegisterInput) {
	const resp = await fetch(`http://127.0.0.1:${port}/start`, {
		method: "POST",
		headers: {
			...HOST_HEADER(port),
			"Content-Type": "application/json",
		},
		body: JSON.stringify(input),
	});
	if (!resp.ok) {
		throw new DgCliError(
			`session registration failed: ${resp.status} ${await resp.text()}`,
		);
	}
	return validateSessionBootstrap(await resp.json());
}

export type StartOptions = {
	workset?: string;
	role?: SessionRole;
	agentIdentity?: string;
	open?: boolean;
};

/**
 * `start`: reuse a live daemon if one answers /health, otherwise daemonize a
 * fresh `__serve`; either way, register a new session and print its
 * bootstrap URL. Never binds a port itself — that only ever happens in `__serve`.
 */
export async function cmdStart(options: StartOptions = {}): Promise<void> {
	const paths = resolveDgPaths();
	const existing = readLockfile(paths);
	const existingLive = existing ? await isDaemonLive(existing) : false;

	let targetPort: number;
	if (existing && existingLive) {
		if (existing.versions.protocol !== CHAT_PROTOCOL_VERSION) {
			const status = await fetchStatus(existing.port);
			throw new DgCliError(
				`dg-server: the running daemon speaks protocol v${existing.versions.protocol}, ` +
					`this CLI speaks v${CHAT_PROTOCOL_VERSION}. Refusing to attach — stopping it would ` +
					`end ${status?.sessionCount ?? "an unknown number of"} live session(s); dg-server ` +
					"never auto-restarts a shared daemon. Stop it yourself once nothing depends on it.",
				EXIT_PROTOCOL_MISMATCH,
			);
		}
		targetPort = existing.port;
	} else {
		// Runs in this foregrounded CLI process, not the detached __serve
		// child (stdio ignored there) — the only place the refusal reaches the user.
		await checkWslNetworking();
		spawnDaemonProcess();
		targetPort = (await waitForFreshDaemon(paths)).port;
	}

	const bootstrap = await registerSession(targetPort, {
		cwd: process.cwd(),
		role: options.role ?? "agent",
		workset: options.workset,
		agentIdentity: options.agentIdentity,
	});
	const url = buildBootstrapUrl(targetPort, bootstrap);
	console.log(url);
	if (options.open) {
		const { tryOpen } = await import("@dg/common/node");
		await tryOpen(url);
	}
}

async function fetchStatus(port: number) {
	try {
		const resp = await fetch(`http://127.0.0.1:${port}/status`, {
			headers: HOST_HEADER(port),
		});
		if (!resp.ok) return undefined;
		return (await resp.json()) as { sessionCount?: number };
	} catch {
		return undefined;
	}
}

/** `status`: report the live daemon's /status, or clean up and report absence. */
export async function cmdStatus(): Promise<void> {
	const paths = resolveDgPaths();
	const handle = readLockfile(paths);
	if (!handle) {
		console.log("dg-server: no live daemon");
		return;
	}
	if (!(await isDaemonLive(handle))) {
		removeLockfile(paths);
		console.log("dg-server: no live daemon (stale lockfile removed)");
		return;
	}
	const resp = await fetch(`http://127.0.0.1:${handle.port}/status`, {
		headers: HOST_HEADER(handle.port),
	});
	console.log(JSON.stringify(await resp.json(), null, 2));
}

/**
 * `__serve`: the hidden, always-foregrounded daemon process. Binds the first
 * available candidate port (a second bind on an already-bound port throwing
 * is the cold-start mutex), wires the session/connection/idle machinery, and
 * writes the lockfile only once actually listening.
 */
export async function cmdServe(): Promise<void> {
	const paths = resolveDgPaths();
	const wslNetworkingMode = await checkWslNetworking();

	const logger = createLogger(paths);
	const registry = new SessionRegistry(paths);
	const connections = new ConnectionManager();
	const instanceId = newInstanceId();

	let idleController: ReturnType<typeof createIdleController> | undefined;
	const noteActivity = () => idleController?.noteActivity();

	const statusDeps: HttpServerDeps["statusDeps"] = {
		wslNetworkingMode,
		getLastError: () => logger.getLastError(),
		// No signal exists yet in this slice for which extension build is
		// talking to the daemon — honestly report unknown rather than guess.
		getExtensionVersion: () => null,
	};

	let boundPort: number | undefined;
	let server: ReturnType<typeof createHttpServer> | undefined;
	let lastBindError: unknown;
	for (const candidate of candidatePorts()) {
		try {
			server = createHttpServer({
				port: candidate,
				instanceId,
				paths,
				registry,
				connections,
				logger,
				noteActivity,
				statusDeps,
			});
			boundPort = candidate;
			break;
		} catch (err) {
			lastBindError = err;
			// A cold-start race winner may already hold `candidate` — defer to it
			// instead of advancing to a fallback port and clobbering its lockfile.
			const liveHandle = await awaitBindRival(paths);
			if (liveHandle) {
				logger.warn(
					`port ${candidate} bind conflict: deferring to daemon instance ${liveHandle.instanceId} already live on ${liveHandle.port}`,
				);
				process.exit(0);
			}
		}
	}
	if (!server || boundPort === undefined) {
		throw new DgCliError(
			`no available port in the configured range (${String(lastBindError)})`,
			EXIT_NO_PORT_AVAILABLE,
		);
	}
	const boundServer = server;
	const boundPortNumber = boundPort;

	idleController = createIdleController({
		ttlMs: process.env.DG_IDLE_TTL_MS
			? Number(process.env.DG_IDLE_TTL_MS)
			: DEFAULT_IDLE_TTL_MS,
		isIdle: () => registry.activeCount() === 0 && connections.openCount() === 0,
		onExpire: () => {
			logger.info("idle TTL expired with no sessions or connections — exiting");
			void shutdown("daemon-shutdown");
		},
	});

	// Queued session-closed sends triggered by shutdown's own closeAll() below —
	// awaited before exit so they actually leave the wire, not just the queue.
	const pendingCloseSends: Promise<void>[] = [];

	// The one place session-closed is broadcast and the capability revoked —
	// covers every legitimate closer (CLI verb, canvas frame, daemon shutdown).
	registry.on(
		"closed",
		({ sessionId, reason }: { sessionId: string; reason: CloseReason }) => {
			logger.info(`session ${sessionId} closed (${reason})`);
			connections.forEachCapableOf(sessionId, (ws) => {
				pendingCloseSends.push(
					sendViaQueue(
						ws,
						JSON.stringify({
							sessionId,
							protocolVersion: CHAT_PROTOCOL_VERSION,
							type: "session-closed",
						}),
					),
				);
				ws.data.capabilities.delete(sessionId);
			});
		},
	);
	// Single broadcast source for session-list — create() and close() both emit
	// "changed", so REST-, WS-, and close-triggered refreshes can never desync.
	registry.on("changed", ({ sessionId }: { sessionId: string }) => {
		connections.broadcastToPages({
			sessionId,
			protocolVersion: CHAT_PROTOCOL_VERSION,
			type: "session-list",
			sessions: registry.list(),
		});
		noteActivity();
	});

	writeLockfileAtomic(paths, {
		pid: process.pid,
		port: boundPortNumber,
		instanceId,
		versions: {
			package: DG_SERVER_PACKAGE_VERSION,
			protocol: CHAT_PROTOCOL_VERSION,
		},
	});

	let shuttingDown = false;
	async function shutdown(reason: "daemon-shutdown"): Promise<void> {
		if (shuttingDown) return;
		shuttingDown = true;
		idleController?.stop();
		registry.closeAll(reason);
		await Promise.all(pendingCloseSends); // let queued session-closed frames leave the wire before exit
		removeLockfile(paths);
		boundServer.stop(true);
		process.exit(0);
	}
	process.on("SIGTERM", () => void shutdown("daemon-shutdown"));
	process.on("SIGINT", () => void shutdown("daemon-shutdown"));

	logger.info(
		`dg-server listening on 127.0.0.1:${boundPortNumber} (instance ${instanceId})`,
	);
}
