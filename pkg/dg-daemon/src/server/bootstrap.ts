import {
	CHAT_PROTOCOL_VERSION,
	DgCliError,
	EXIT_NO_PORT_AVAILABLE,
	wait,
} from "@dg/common";
import {
	checkWslNetworking,
	type DgPaths,
	isDaemonLive,
	loopbackHostHeader,
	readPidFile,
	removePidFile,
	resolveDgPaths,
	writePidFileAtomic,
} from "@dg/common/node";
import { DispatchScheduler } from "../dispatch";
import { isDaemonIdle } from "../jobs/idle";
import { JOB_TICK_INTERVAL_MS, startJobRunner } from "../jobs/runner";
import { type CloseReason, SessionRegistry } from "../session/registry";
import { AGENT_MESSAGE_RETENTION_DAYS, ChatStore } from "../store";
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
import { DG_DAEMON_PACKAGE_VERSION } from "./status";

const BIND_RIVAL_BUDGET_MS = 500;
const BIND_RIVAL_POLL_MS = 20;

async function awaitBindRival(
	paths: DgPaths,
): Promise<ReturnType<typeof readPidFile>> {
	const deadline = Date.now() + BIND_RIVAL_BUDGET_MS;
	for (;;) {
		const handle = readPidFile(paths);
		if (handle && (await isDaemonLive(handle))) return handle;
		if (Date.now() >= deadline) return undefined;
		await wait(BIND_RIVAL_POLL_MS);
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
		headers: loopbackHostHeader(handle.port),
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
	const dispatchScheduler = new DispatchScheduler();
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
				dispatchScheduler,
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
		isIdle: () =>
			isDaemonIdle(
				registry.activeCount(),
				connections.openCount(),
				store.countEnabledJobs(),
			),
		onExpire: () => {
			logger.info(
				"idle TTL expired with no sessions, connections or enabled jobs — exiting",
			);
			void shutdown("daemon-shutdown");
		},
	});

	const jobRunner = startJobRunner(
		{ store, scheduler: dispatchScheduler, logger },
		readEnvNumber(process.env, "DG_JOB_TICK_MS", JOB_TICK_INTERVAL_MS),
	);

	const sessionTtlMs = readEnvNumber(
		process.env,
		"DG_SESSION_TTL_MS",
		DEFAULT_IDLE_TTL_MS,
	);
	const hasLivePageSocket = (sessionId: string): boolean => {
		let live = false;
		connections.forEachCapableOf(sessionId, (ws) => {
			if (ws.data.kind === "ws") live = true;
		});
		return live;
	};
	const reapTimer = setInterval(
		() => {
			registry.reapExpired(sessionTtlMs, hasLivePageSocket);
			const pruned = store.pruneAgentMessages(new Date());
			if (pruned > 0) {
				logger.info(
					`pruned ${pruned} agent message(s) past the ${AGENT_MESSAGE_RETENTION_DAYS}-day retention window`,
				);
			}
		},
		Math.min(sessionTtlMs, 60_000),
	);
	reapTimer.unref?.();

	const pendingCloseSends = new Set<Promise<void>>();

	registry.on(
		"closed",
		({ sessionId, reason }: { sessionId: string; reason: CloseReason }) => {
			logger.info(`session ${sessionId} closed (${reason})`);
			connections.forEachCapableOf(sessionId, (ws) => {
				const send = sendViaQueue(
					ws,
					JSON.stringify({
						sessionId,
						protocolVersion: CHAT_PROTOCOL_VERSION,
						type: "session-closed",
					}),
				);
				pendingCloseSends.add(send);
				void send.finally(() => pendingCloseSends.delete(send));
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
			package: DG_DAEMON_PACKAGE_VERSION,
			protocol: CHAT_PROTOCOL_VERSION,
		},
	});

	let shuttingDown = false;
	async function shutdown(reason: "daemon-shutdown"): Promise<void> {
		if (shuttingDown) return;
		shuttingDown = true;
		idleController?.stop();
		jobRunner.stop();
		clearInterval(reapTimer);
		registry.closeAll(reason);
		await Promise.all(pendingCloseSends);
		removePidFile(paths);
		boundServer.stop(true);
		store.close();
		await logger.flush();
		process.exit(0);
	}
	process.on("SIGTERM", () => void shutdown("daemon-shutdown"));
	process.on("SIGINT", () => void shutdown("daemon-shutdown"));

	logger.info(
		`dg-daemon listening on 127.0.0.1:${boundPortNumber} (instance ${instanceId})`,
	);
}
