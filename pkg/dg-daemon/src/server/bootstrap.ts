import { dirname } from "node:path";
import {
	CHAT_PROTOCOL_VERSION,
	DgCliError,
	describeError,
	EXIT_NO_PORT_AVAILABLE,
	wait,
} from "@dg/common";
import { exitAfterDrain } from "@dg/common/async";
import {
	checkWslNetworking,
	defaultAutostartDeps,
	type DgPaths,
	ensureDaemonId,
	ensureOwnerToken,
	ensurePrivateDir,
	isDaemonLive,
	loopbackHostHeader,
	readPidFile,
	removePidFile,
	resolveDgPaths,
	resolveLiveDaemon,
	withInstallLockSync,
	writePidFileAtomic,
} from "@dg/common/node";
import { assertNotBlocked } from "@dg/common/node/layout";
import { rewriteDaemonAutostart } from "../commands/autostart";
import { DispatchScheduler } from "../dispatch";
import { countEnabledScheduled, parseJobs } from "../jobs/config";
import { createRefreshLimiter } from "../jobs/credential-refresh";
import { createJobControl } from "../jobs/control";
import { defaultRunSource } from "../jobs/secret-sources";
import { isDaemonIdle } from "../jobs/idle";
import {
	compiledBackupPath,
	migrateLauncherArgv,
	migrateScheduledRows,
	migrateServicesKey,
	servicesBackupPath,
} from "../jobs/migrate";
import { createJobRunner, JOB_TICK_INTERVAL_MS } from "../jobs/runner";
import { createSupervisor, MAX_LOG_BYTES } from "../services/supervisor";
import {
	DEFAULT_ARCHIVE_MAX_ROWS,
	DEFAULT_ARCHIVE_TTL_MS,
	WAL_CHECKPOINT_PAGE_THRESHOLD,
} from "../session/archive";
import {
	DEFAULT_AGENT_GONE_MS,
	DEFAULT_CLI_REATTACH_GRACE_MS,
} from "../session/liveness";
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
import { readConfig, readConfigStrict } from "./config-store";
import { ConnectionManager, isExtensionPeer, sendViaQueue } from "./connection";
import { createHttpServer, type HttpServerDeps, newInstanceId } from "./http";
import { createIdleController, DEFAULT_IDLE_TTL_MS } from "./idle-ttl";
import { createLogger } from "./log";
import { candidatePorts } from "./ports";
import {
	claimSingleInstance,
	removeActiveDaemon,
} from "./single-instance";
import { DG_DAEMON_PACKAGE_VERSION } from "./status";

/** How often the row-cap prunes run, independent of the much faster session reap tick. */
export const ROW_PRUNE_INTERVAL_MS = 3_600_000;

const CONFIG_LOCK = { tries: 40, waitMs: 50 };
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
	assertNotBlocked(paths, "daemon");
	const resolved = await resolveLiveDaemon(paths);
	if (!resolved) return;
	const { handle } = resolved;
	if (!resolved.live) {
		console.log(
			`dg daemon (pid ${handle.pid}) does not answer — run dg daemon stop --force`,
		);
		return;
	}
	const resp = await fetch(`http://127.0.0.1:${handle.port}/status`, {
		headers: loopbackHostHeader(handle.port),
	});
	console.log(JSON.stringify(await resp.json(), null, 2));
}

const launcherHead = (argv: readonly string[]): string => argv.slice(0, 2).join(" ");

function migrateJobsConfig(
	paths: DgPaths,
	store: ChatStore,
	logger: ReturnType<typeof createLogger>,
): void {
	const file = paths.daemonConfigPath;
	try {
		ensurePrivateDir(dirname(file));
		const { moved, rows, rewritten } = withInstallLockSync(
			dirname(file),
			() => ({
				...migrateServicesKey(paths),
				rows: migrateScheduledRows(store, paths, logger),
				...migrateLauncherArgv(paths),
			}),
			CONFIG_LOCK,
		);
		for (const job of rewritten) {
			logger.info(`job "${job.name}": program ${job.from[0]} is now ${launcherHead(job.to)}; backup ${compiledBackupPath(paths)}`);
		}
		if (moved.length > 0) {
			logger.info(
				`moved ${moved.length} service(s) to "jobs"; backup ${servicesBackupPath(paths)}`,
			);
		}
		if (rows.moved.length > 0) {
			logger.info(`moved ${rows.moved.length} scheduled job(s) to "jobs"`);
		}
		if (Object.hasOwn(readConfig(paths), "services")) {
			logger.warn(
				`${file}: "services" is not an object, so it stays in the file and nothing moved`,
			);
		}
	} catch (err) {
		logger.warn(`${describeError(err)}; the jobs config was not migrated`);
	}
}

export async function cmdServe(): Promise<"serving" | "deferred"> {
	const paths = resolveDgPaths();
	const wslNetworkingMode = await checkWslNetworking();

	const logger = createLogger(paths);
	ensureOwnerToken(paths);
	const daemonId = ensureDaemonId(paths);
	const store = await ChatStore.open(paths);
	const credentials = await CredentialStore.open(paths, store.cryptoMeta());
	store.recoverStaleClaims();
	setKeySourceProvider(() => store.cryptoMeta().keySource);
	setUserVersionProvider(() => store.userVersion());
	const registry = new SessionRegistry(paths, { store });
	const connections = new ConnectionManager();
	const dispatchScheduler = new DispatchScheduler();
	let boundPort: number | undefined;
	migrateJobsConfig(paths, store, logger);
	await rewriteDaemonAutostart(defaultAutostartDeps(), paths).then(
		(result) => {
			if (result.status === "rewritten") logger.info(`autostart unit ${result.path} now runs the compiled dg; backup ${result.backup}`);
		},
		(err: unknown) => logger.warn(`${describeError(err)}; the autostart unit was not rewritten, run dg autostart install`),
	);
	const readCredential = (name: string) =>
		credentials.getCredential(name)?.value;
	const supervisor = createSupervisor({
		paths,
		daemonUrl: () => {
			if (boundPort === undefined) throw new Error("daemon port is not bound");
			return `http://127.0.0.1:${boundPort}`;
		},
		loadConfig: () => readConfig(paths),
		logger,
		readCredential,
	});
	const jobRunner = createJobRunner({
		store,
		scheduler: dispatchScheduler,
		logger,
		loadConfig: () => readConfig(paths),
		launcher: {
			paths,
			daemonUrl: () => {
				if (boundPort === undefined) {
					throw new Error("daemon port is not bound");
				}
				return `http://127.0.0.1:${boundPort}`;
			},
			logger,
			maxLogBytes: MAX_LOG_BYTES,
			readCredential,
		},
	});
	const instanceId = newInstanceId();

	let idleController: ReturnType<typeof createIdleController> | undefined;
	const noteActivity = () => idleController?.noteActivity();

	const statusDeps: HttpServerDeps["statusDeps"] = {
		wslNetworkingMode,
		getLastError: () => logger.getLastError(),
		getExtensionVersion: () => connections.extensionVersion(),
	};

	const refreshLimiter = createRefreshLimiter();
	let server: ReturnType<typeof createHttpServer> | undefined;
	let lastBindError: unknown;
	for (const candidate of candidatePorts()) {
		try {
			server = createHttpServer({
				port: candidate,
				instanceId,
				daemonId,
				paths,
				registry,
				connections,
				logger,
				noteActivity,
				statusDeps,
				store,
				credentials,
				dispatchScheduler,
				jobs: createJobControl(supervisor, jobRunner),
				readJobs: () => parseJobs(readConfigStrict(paths)),
				refresh: {
					which: (program, env) => Bun.which(program, env),
					runSource: defaultRunSource,
					now: Date.now,
					limiter: refreshLimiter,
				},
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
				return "deferred";
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
				countEnabledScheduled(readConfig(paths)),
				supervisor.runningCount(),
			),
		onExpire: () => {
			logger.info(
				"idle TTL expired with no sessions, connections, enabled jobs or running services — exiting",
			);
			void shutdown("daemon-shutdown");
		},
	});

	const jobTicker = jobRunner.start(
		readEnvNumber(process.env, "DG_JOB_TICK_MS", JOB_TICK_INTERVAL_MS),
	);

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
			const payload = JSON.stringify({
				sessionId,
				protocolVersion: CHAT_PROTOCOL_VERSION,
				type: "session-closed",
			});
			const notified = new Set<object>();
			const notify = (ws: Parameters<typeof sendViaQueue>[0]) => {
				const send = sendViaQueue(ws, payload);
				pendingCloseSends.add(send);
				void send.finally(() => pendingCloseSends.delete(send));
				notified.add(ws);
			};
			const keepsExtensionState = reason === "daemon-shutdown";
			connections.forEachCapableOf(sessionId, (ws) => {
				if (!(keepsExtensionState && isExtensionPeer(ws))) notify(ws);
				ws.data.capabilities.delete(sessionId);
			});
			if (keepsExtensionState) return;
			connections.forEachExtension((ws) => {
				if (!notified.has(ws)) notify(ws);
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
	await claimSingleInstance(paths, {
		pid: process.pid,
		port: boundPortNumber,
		instanceId,
		version: DG_DAEMON_PACKAGE_VERSION,
	});

	let shuttingDown = false;
	async function shutdown(reason: "daemon-shutdown"): Promise<void> {
		if (shuttingDown) return;
		shuttingDown = true;
		idleController?.stop();
		jobTicker.stop();
		await jobRunner.stopAll();
		await supervisor.stopAll();
		clearInterval(reapTimer);
		registry.closeAll(reason);
		await Promise.all(pendingCloseSends);
		removePidFile(paths);
		removeActiveDaemon({ pid: process.pid, instanceId });
		boundServer.stop(true);
		store.close();
		credentials.close();
		await logger.flush();
		await exitAfterDrain(0);
	}
	process.on("SIGTERM", () => void shutdown("daemon-shutdown"));
	process.on("SIGINT", () => void shutdown("daemon-shutdown"));

	logger.info(
		`dg daemon listening on 127.0.0.1:${boundPortNumber} (instance ${instanceId})`,
	);
	supervisor.autostart();
	return "serving";
}
