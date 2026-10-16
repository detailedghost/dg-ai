import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { describeError, withTimeout } from "@dg/common";
import {
	ensurePrivateDir,
	rotateLogIfLarge,
	runCapture,
	writeFileAtomic,
} from "@dg/common/node";
import { type ChannelConfig, saveReactionSlot } from "../config";
import { createEngine, type Engine, type Log, type ProcessSeam } from "../engine";
import { type FunEntry, filterVerifiedFun, loadFunPool } from "../fun";
import type { ChannelReviewPaths } from "../paths";
import {
	RelayAuthError,
	validateReactionIds,
} from "../providers/teams-relay";
import type { ChatEvent, ChatProvider } from "../providers/types";
import { createAddressWorkspace } from "../address";
import { createGrantCredentialSource, resolveSecrets } from "../credentials";
import { startAutomation } from "../automation/start";
import { createRunners } from "../runners";
import { RUNNER_NAMES, type Runner, type RunnerName } from "../runners/types";
import { createStateStore } from "../state";
import { createStackReader, createVerdictReader } from "../verdict";
import type { VerdictReader } from "../verdict/types";
import { authRemedy, connect } from "./connect";
import { isOurDaemon, readPidRecord } from "./pid";
import { type PlatformSeam, processSeam } from "./platform";
import {
	type Connection,
	type DaemonSeams,
	type ResolvedEnv,
	SERVE_PROBE_TIMEOUT_MS,
} from "./shared";

const SERVE_STOP_TIMEOUT_MS = 10_000;
const DAY_MS = 24 * 3_600_000;
const LOG_CHECK_INTERVAL_MS = 3_600_000;
const LOG_MAX_BYTES = 10 * 1024 * 1024;

function switchable(initial: ChatProvider) {
	let current = initial;
	const provider: ChatProvider = {
		resolveChat: (query) => current.resolveChat(query),
		subscribe: (request) => current.subscribe(request),
		react: (request) => current.react(request),
		unreact: (request) => current.unreact(request),
		reply: (request) => current.reply(request),
		dm: (request) => current.dm(request),
		listReactions: () => current.listReactions(),
	};
	return {
		provider,
		swap(next: ChatProvider) {
			current = next;
		},
	};
}

function readers(config: ChannelConfig, seams: DaemonSeams, log: Log) {
	return {
		runners: seams.runners ?? createRunners(config),
		verdict: seams.verdict ?? createVerdictReader({ runCapture }),
		stack:
			seams.stack ??
			createStackReader({ runCapture, hosts: config.hosts, log }),
		workspace: seams.workspace ?? createAddressWorkspace(runCapture),
	};
}

export function buildEngine({
	config,
	provider,
	defaultChatId,
	botName,
	paths,
	seams,
	log,
	funPool,
	platform,
}: {
	config: ChannelConfig;
	provider: ChatProvider;
	defaultChatId: string;
	botName: string;
	paths: ChannelReviewPaths;
	seams: DaemonSeams;
	log: Log;
	funPool: FunEntry[];
	platform: PlatformSeam;
}): {
	engine: Engine;
	state: ReturnType<typeof createStateStore>;
	process: ProcessSeam;
} {
	const state = createStateStore(
		paths.statePath,
		undefined,
		undefined,
		defaultChatId,
	);
	const engine = createEngine({
		provider,
		paths,
		...readers(config, seams, log),
		state,
		config,
		defaultChatId,
		botName,
		funPool,
		random: seams.random ?? Math.random,
		log,
		clock: () => new Date(),
		startTime: (pid) => platform.startTime(pid),
		persistReaction: (slot, id) => saveReactionSlot(paths.configPath, slot, id),
	});
	return { engine, state, process: processSeam(platform) };
}

async function probeAll(
	runners: Record<RunnerName, Runner>,
	verdict: VerdictReader,
	ms: number,
	log: Log,
): Promise<void> {
	const check = async (
		label: string,
		work: () => Promise<{ ok: true } | { ok: false; code: string }>,
	) => {
		try {
			const result = await withTimeout(work(), ms);
			if (result === undefined)
				log.warn(`${label} probe timed out after ${ms} ms`);
			else if (!result.ok) log.warn(`${label} probe failed: ${result.code}`);
		} catch (error) {
			log.warn(`${label} probe error: ${describeError(error)}`);
		}
	};
	await Promise.all([
		...RUNNER_NAMES.map((name) =>
			check(`runner ${name}`, () => runners[name].probe()),
		),
		...(["github", "gitlab"] as const).map((host) =>
			check(`${host} CLI`, () => verdict.probe({ host })),
		),
	]);
}

function startMaintenance({
	engine,
	logPath,
	seams,
	log,
}: {
	engine: Engine;
	logPath: string;
	seams: DaemonSeams;
	log: Log;
}): () => void {
	const every = (label: string, ms: number, work: () => void) => {
		const timer = setInterval(() => {
			try {
				work();
			} catch (error) {
				log.warn(`${label} failed: ${describeError(error)}`);
			}
		}, ms);
		timer.unref();
		return timer;
	};
	const timers = [
		every("maintenance", seams.maintenanceIntervalMs ?? DAY_MS, () =>
			engine.maintain(),
		),
		every("log rotation", seams.logCheckIntervalMs ?? LOG_CHECK_INTERVAL_MS, () =>
			rotateLogIfLarge(logPath, LOG_MAX_BYTES),
		),
	];
	return () => {
		for (const timer of timers) clearInterval(timer);
	};
}

export async function serve({
	config,
	env,
	paths,
	overrides,
	log,
	seams,
	platform,
	signal,
}: {
	config: ChannelConfig;
	env: ResolvedEnv;
	paths: ChannelReviewPaths;
	overrides: { runner?: RunnerName; chatId?: string };
	log: Log;
	seams: DaemonSeams;
	platform: PlatformSeam;
	signal: AbortSignal;
}): Promise<number> {
	log.info(
		`channel-review daemon env ${env.name} (${env.baseUrl}, AWS profile ${env.awsProfile})`,
	);
	const existing = readPidRecord(paths.pidPath);
	if (
		existing !== undefined &&
		existing.pid !== process.pid &&
		(await isOurDaemon(existing.pid, platform))
	) {
		log.error(
			`a ${env.name} daemon is already running (pid ${existing.pid}); stop it first`,
		);
		return 1;
	}

	const effective: ChannelConfig = overrides.runner
		? { ...config, runner: { ...config.runner, default: overrides.runner } }
		: config;

	const secrets = await resolveSecrets({
		envName: env.name,
		env: seams.env ?? process.env,
		source: seams.credentials ?? createGrantCredentialSource(),
	});
	if (secrets.warning) log.warn(secrets.warning);
	seams = { ...seams, env: secrets.env };

	let connection: Connection;
	let funPool: FunEntry[];
	try {
		connection = await connect({ config, env, overrides, seams, log });
		const listed = await connection.provider.listReactions();
		validateReactionIds(
			Object.fromEntries(
				Object.entries(config.reactions).map(([key, id]) => [
					`reactions.${key}`,
					id,
				]),
			),
			listed,
		);
		funPool = filterVerifiedFun(config.fun.pool ?? loadFunPool(), listed, log);
	} catch (error) {
		log.error(
			error instanceof RelayAuthError
				? authRemedy(config, env)
				: describeError(error),
		);
		return 1;
	}
	const { chats } = connection;
	const switcher = switchable(connection.provider);
	const { runners, verdict } = readers(effective, seams, log);
	const {
		engine,
		state,
		process: processes,
	} = buildEngine({
		config: effective,
		provider: switcher.provider,
		defaultChatId: chats[0].id,
		botName: env.botName,
		paths,
		seams: { ...seams, runners, verdict },
		log,
		funPool,
		platform,
	});

	await probeAll(
		runners,
		verdict,
		seams.probeTimeoutMs ?? SERVE_PROBE_TIMEOUT_MS,
		log,
	);

	if (signal.aborted) return 0;
	try {
		await engine.recover(processes);
	} catch (error) {
		log.error(`recovery failed: ${describeError(error)}`);
		return 1;
	}

	if (signal.aborted) return 0;
	ensurePrivateDir(dirname(paths.pidPath));
	writeFileAtomic(
		paths.pidPath,
		JSON.stringify({
			pid: process.pid,
			env: env.name,
			startedAt: new Date().toISOString(),
			chats,
		}),
		0o600,
	);
	log.info(
		`daemon started for ${chats.map(({ id }) => `chat ${id}`).join(", ")} (pid ${process.pid})`,
	);
	const stopMaintenance = startMaintenance({
		engine,
		logPath: paths.logPath,
		seams,
		log,
	});
	const automation = startAutomation({
		config: effective,
		engine,
		state,
		provider: switcher.provider,
		jobsDir: paths.jobsDir,
		seams,
		log,
		signal,
	});

	async function dispatch(chatId: string, event: ChatEvent): Promise<void> {
		if (event.type === "gap") {
			log.warn(`chat ${chatId}: event gap, the relay lost events between reconnects`);
			return;
		}
		if (event.type === "message") {
			try {
				await engine.handle(event.message);
			} catch (error) {
				log.error(
					`chat ${chatId}: message ${event.message.id} failed: ${describeError(error)}`,
				);
				return;
			}
		} else if (event.type === "reaction") {
			try {
				await engine.handleReaction(event.reaction);
			} catch (error) {
				log.error(
					`chat ${chatId}: reaction ${event.reaction.id} failed: ${describeError(error)}`,
				);
				return;
			}
		} else {
			log.info(`chat ${chatId}: skipped ${String((event as { type: unknown }).type)} event`);
		}
		if (typeof event.eventId === "string") {
			state.setLastEventId(chatId, event.eventId);
		}
	}

	async function pump(chatId: string): Promise<number> {
		let refetched = false;
		for (;;) {
			try {
				for await (const event of switcher.provider.subscribe({
					chatId,
					resumeId: state.get().lastEventIds[chatId],
					signal,
				})) {
					refetched = false;
					await dispatch(chatId, event);
				}
				if (signal.aborted) return 0;
				log.error(`chat ${chatId}: the event stream ended unexpectedly`);
				return 1;
			} catch (error) {
				if (signal.aborted) return 0;
				if (!(error instanceof RelayAuthError)) {
					log.error(`chat ${chatId}: ${describeError(error)}`);
					return 1;
				}
				if (refetched) {
					log.error(authRemedy(config, env));
					return 1;
				}
				refetched = true;
				log.warn(
					`chat ${chatId}: the relay rejected the secret; fetching a fresh one`,
				);
				try {
					const next = await connect({
						config,
						env,
						overrides: { chatId },
						seams,
						log,
					});
					switcher.swap(next.provider);
				} catch (refetchError) {
					log.error(`chat ${chatId}: ${describeError(refetchError)}`);
					return 1;
				}
			}
		}
	}

	let code: number;
	try {
		const codes = await Promise.all(chats.map(({ id }) => pump(id)));
		code = codes.includes(0) ? 0 : 1;
	} finally {
		stopMaintenance();
		await automation.stop();
		await withTimeout(
			engine.stop(),
			seams.stopTimeoutMs ?? SERVE_STOP_TIMEOUT_MS,
		);
		state.flush();
		rmSync(paths.pidPath, { force: true });
	}
	return code;
}
