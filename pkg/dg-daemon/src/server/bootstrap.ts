import {
	CHAT_PROTOCOL_VERSION,
	DgCliError,
	EXIT_NO_PORT_AVAILABLE,
} from "@dg/common";
import {
	checkWslNetworking,
	type DgPaths,
	isDaemonLive,
	readPidFile,
	removePidFile,
	resolveDgPaths,
	writePidFileAtomic,
} from "@dg/common/node";
import { type CloseReason, SessionRegistry } from "../session/registry";
import { ChatStore } from "../store";
import { readEnvNumber } from "../utils/env";
import {
	setKeySourceProvider,
	setUserVersionProvider,
} from "../utils/key-source";
import { ConnectionManager, sendViaQueue } from "./connection";
import { createHttpServer, type HttpServerDeps, newInstanceId } from "./http";
import { createIdleController, DEFAULT_IDLE_TTL_MS } from "./idle-ttl";
import { createLogger } from "./log";
import { candidatePorts } from "./ports";
import { DG_SERVER_PACKAGE_VERSION } from "./status";

const HOST_HEADER = (port: number) => ({ Host: `127.0.0.1:${port}` });

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function awaitBindRival(
	paths: DgPaths,
	budgetMs = 500,
	pollMs = 20,
): Promise<ReturnType<typeof readPidFile>> {
	const deadline = Date.now() + budgetMs;
	for (;;) {
		const handle = readPidFile(paths);
		if (handle && (await isDaemonLive(handle))) return handle;
		if (Date.now() >= deadline) return undefined;
		await sleep(pollMs);
	}
}

export async function cmdStatus(): Promise<void> {
	const paths = resolveDgPaths();
	const handle = readPidFile(paths);
	if (!handle) {
		console.log("dg-daemon: no live daemon");
		return;
	}
	if (!(await isDaemonLive(handle))) {
		removePidFile(paths);
		console.log("dg-daemon: no live daemon (stale pid file removed)");
		return;
	}
	const resp = await fetch(`http://127.0.0.1:${handle.port}/status`, {
		headers: HOST_HEADER(handle.port),
	});
	console.log(JSON.stringify(await resp.json(), null, 2));
}

export async function cmdServe(): Promise<void> {
	const paths = resolveDgPaths();
	const wslNetworkingMode = await checkWslNetworking();

	const logger = createLogger(paths);
	const store = await ChatStore.open(paths);
	store.recoverStaleClaims();
	setKeySourceProvider(() => store.cryptoMeta().keySource);
	setUserVersionProvider(() => store.userVersion());
	const registry = new SessionRegistry(paths);
	const connections = new ConnectionManager();
	const instanceId = newInstanceId();

	let idleController: ReturnType<typeof createIdleController> | undefined;
	const noteActivity = () => idleController?.noteActivity();

	const statusDeps: HttpServerDeps["statusDeps"] = {
		wslNetworkingMode,
		getLastError: () => logger.getLastError(),
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
				store,
			});
			boundPort = candidate;
			break;
		} catch (err) {
			lastBindError = err;
			const liveHandle = await awaitBindRival(paths);
			if (liveHandle) {
				logger.warn(
					`port ${candidate} bind conflict: deferring to daemon instance ${liveHandle.instanceId} already live on ${liveHandle.port}`,
				);
				store.close();
				process.exit(0);
			}
		}
	}
	if (!server || boundPort === undefined) {
		store.close();
		throw new DgCliError(
			`no available port in the configured range (${String(lastBindError)})`,
			EXIT_NO_PORT_AVAILABLE,
		);
	}
	const boundServer = server;
	const boundPortNumber = boundPort;

	idleController = createIdleController({
		ttlMs: readEnvNumber(process.env, "DG_IDLE_TTL_MS", DEFAULT_IDLE_TTL_MS),
		isIdle: () => registry.activeCount() === 0 && connections.openCount() === 0,
		onExpire: () => {
			logger.info("idle TTL expired with no sessions or connections — exiting");
			void shutdown("daemon-shutdown");
		},
	});

	const pendingCloseSends: Promise<void>[] = [];

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
	registry.on("changed", ({ sessionId }: { sessionId: string }) => {
		connections.broadcastToPages({
			sessionId,
			protocolVersion: CHAT_PROTOCOL_VERSION,
			type: "session-list",
			sessions: registry.list(),
		});
		noteActivity();
	});

	writePidFileAtomic(paths, {
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
		await Promise.all(pendingCloseSends);
		removePidFile(paths);
		boundServer.stop(true);
		store.close();
		process.exit(0);
	}
	process.on("SIGTERM", () => void shutdown("daemon-shutdown"));
	process.on("SIGINT", () => void shutdown("daemon-shutdown"));

	logger.info(
		`dg-daemon listening on 127.0.0.1:${boundPortNumber} (instance ${instanceId})`,
	);
}
