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
import { createSupervisor } from "../services/supervisor";
import { type CloseReason, SessionRegistry } from "../session/registry";
import {
	AGENT_MESSAGE_RETENTION_DAYS,
	ChatStore,
	FEED_ITEM_RETENTION_ROW_LIMIT,
	MESSAGE_RETENTION_ROW_LIMIT,
} from "../store";
import { CredentialStore } from "../store/credentials-store";
import { readEnvNumber } from "../utils/env";
import {
	setKeySourceProvider,
	setUserVersionProvider,
} from "../utils/key-source";
import { readConfig } from "./config-store";
import { ConnectionManager, sendViaQueue } from "./connection";
import { createHttpServer, type HttpServerDeps, newInstanceId } from "./http";
import { createIdleController, DEFAULT_IDLE_TTL_MS } from "./idle-ttl";
import {
	DEFAULT_ARCHIVE_MAX_ROWS,
	DEFAULT_ARCHIVE_TTL_MS,
	WAL_CHECKPOINT_PAGE_THRESHOLD,
} from "../session/archive";
import {
	DEFAULT_AGENT_GONE_MS,
	DEFAULT_CLI_REATTACH_GRACE_MS,
	DEFAULT_UNCLAIMED_TTL_MS,
} from "../session/liveness";
import { createLogger } from "./log";
import { candidatePorts } from "./ports";
import { DG_DAEMON_PACKAGE_VERSION } from "./status";

/** How often the row-cap prunes run, independent of the much faster session reap tick. */
export const ROW_PRUNE_INTERVAL_MS = 3_600_000;

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
	const credentials = await CredentialStore.open(paths, store.cryptoMeta());
	store.recoverStaleClaims();
	setKeySourceProvider(() => store.cryptoMeta().keySource);
	setUserVersionProvider(() => store.userVersion());
	const registry = new SessionRegistry(paths, { store });
	const connections = new ConnectionManager();
	const dispatchScheduler = new DispatchScheduler();
	const supervisor = createSupervisor({
		paths,
		loadConfig: () => readConfig(paths),
		logger,
	});
	const instanceId = newInstanceId();

	let idleController: ReturnType<typeof createIdleController> | undefined;
	const noteActivity = () => idleController?.noteActivity();

	const statusDeps: HttpServerDeps["statusDeps"] = {
		wslNetworkingMode,
		getLastError: () => logger.getLastError(),
		getExtensionVersion: () => connections.extensionVersion(),
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
				credentials,
				dispatchScheduler,
				supervisor,
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
				credentials.close();
				process.exit(0);
			}
		}
	}
	if (!server || boundPort === undefined) {
		store.close();
		credentials.close();
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
				supervisor.runningCount(),
			),
		onExpire: () => {
			logger.info(
				"idle TTL expired with no sessions, connections, enabled jobs or running services — exiting",
			);
			void shutdown("daemon-shutdown");
		},
	});

	const jobRunner = startJobRunner(
		{ store, scheduler: dispatchScheduler, logger },
		readEnvNumber(process.env, "DG_JOB_TICK_MS", JOB_TICK_INTERVAL_MS),
	);

	supervisor.autostart();

	const sessionTtlMs = readEnvNumber(
		process.env,
		"DG_SESSION_TTL_MS",
		DEFAULT_IDLE_TTL_MS,
	);
	const agentGoneMs = readEnvNumber(
		process.env,
		"DG_AGENT_GONE_MS",
		DEFAULT_AGENT_GONE_MS,
	);
	const unclaimedTtlMs = readEnvNumber(
		process.env,
		"DG_UNCLAIMED_TTL_MS",
		DEFAULT_UNCLAIMED_TTL_MS,
	);
	const reattachGraceMs = readEnvNumber(
		process.env,
		"DG_CLI_REATTACH_GRACE_MS",
		DEFAULT_CLI_REATTACH_GRACE_MS,
	);
	const archiveMaxRows = readEnvNumber(
		process.env,
		"DG_ARCHIVE_MAX_ROWS",
		DEFAULT_ARCHIVE_MAX_ROWS,
	);
	const archiveTtlMs = readEnvNumber(
		process.env,
		"DG_ARCHIVE_TTL_MS",
		DEFAULT_ARCHIVE_TTL_MS,
	);
	const hasLiveCliSocket = (sessionId: string): boolean => {
		let live = false;
		connections.forEachCapableOf(sessionId, (ws) => {
			if (ws.data.kind === "cli") live = true;
		});
		return live;
	};
	let lastRowPruneAt = Date.now();
	const reapTimer = setInterval(
		() => {
			registry.reapExpired(sessionTtlMs, hasLiveCliSocket, {
				agentGoneMs,
				unclaimedTtlMs,
				reattachGraceMs,
			});
			const pruned = store.maintainArchive(
				Date.now(),
				{ maxRows: archiveMaxRows, ttlMs: archiveTtlMs },
				store.walPageCount(),
				WAL_CHECKPOINT_PAGE_THRESHOLD,
			);
			if (pruned.sessions > 0) {
				logger.info(
					`pruned ${pruned.sessions} archived session(s) and ${pruned.messages} message row(s)`,
				);
			}
			const prunedAgentMessages = store.pruneAgentMessages(new Date());
			if (prunedAgentMessages > 0) {
				logger.info(
					`pruned ${prunedAgentMessages} agent message(s) past the ${AGENT_MESSAGE_RETENTION_DAYS}-day retention window`,
				);
			}
			const sinceLastRowPrune = Date.now() - lastRowPruneAt;
			if (sinceLastRowPrune < ROW_PRUNE_INTERVAL_MS) return;
			lastRowPruneAt = Date.now();
			const prunedMessages = store.pruneMessages();
			if (prunedMessages > 0) {
				logger.info(
					`pruned ${prunedMessages} message(s) past the ${MESSAGE_RETENTION_ROW_LIMIT}-row per-session cap`,
				);
			}
			const prunedFeedItems = store.pruneFeedItems();
			if (prunedFeedItems > 0) {
				logger.info(
					`pruned ${prunedFeedItems} feed item(s) past the ${FEED_ITEM_RETENTION_ROW_LIMIT}-row per-job cap`,
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
	registry.on("agent-gone", ({ sessionId }: { sessionId: string }) => {
		store.insertStatusEvent({ sessionId, state: "agent-gone" });
		// manifest-publish is itself delayed 25ms. Delivering agent-gone later
		// keeps that frame, and any command frame already in flight, first.
		const broadcast = setTimeout(() => {
			connections.broadcastToPages({
				sessionId,
				protocolVersion: CHAT_PROTOCOL_VERSION,
				type: "progress",
				state: "agent-gone",
			});
		}, 100);
		broadcast.unref?.();
	});
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
		await supervisor.stopAll();
		clearInterval(reapTimer);
		registry.closeAll(reason);
		await Promise.all(pendingCloseSends);
		removePidFile(paths);
		boundServer.stop(true);
		store.close();
		credentials.close();
		await logger.flush();
		process.exit(0);
	}
	process.on("SIGTERM", () => void shutdown("daemon-shutdown"));
	process.on("SIGINT", () => void shutdown("daemon-shutdown"));

	logger.info(
		`dg-daemon listening on 127.0.0.1:${boundPortNumber} (instance ${instanceId})`,
	);
}
