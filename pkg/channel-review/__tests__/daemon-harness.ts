import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SystemSeams } from "@dg/common/node";
import { type ChannelConfig, loadConfig, resolveEnv } from "../src/config";
import type {
	ChildLike,
	DaemonIo,
	DaemonSeams,
	PlatformSeam,
} from "../src/daemon";
import { serve } from "../src/daemon";
import { loadFunPool } from "../src/fun";
import { type ChannelReviewPaths, channelReviewPaths } from "../src/paths";
import type { ChatEvent, ChatProvider } from "../src/providers/types";
import type { RunnerName } from "../src/runners/types";
import { createStateStore } from "../src/state";
import {
	CHAT_ID,
	type FakeProvider,
	type FakeRunner,
	type RunnerScript,
	createFakeProvider,
	createFakeRunner,
	createFakeStackReader,
	createFakeVerdictReader,
	createRecordedLog,
	createTempHome,
	minimalConfigJson,
} from "./support/fakes";

type SubscribeRequest = Parameters<ChatProvider["subscribe"]>[0];
type Script = (request: SubscribeRequest) => AsyncGenerator<ChatEvent>;

export const DAEMON_ARGS = "/usr/bin/bun /x/dg-skills channel-review run --env dev";

export function untilAbort(signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) resolve();
		else signal.addEventListener("abort", () => resolve(), { once: true });
	});
}

export function holdOpen(...events: ChatEvent[]): Script {
	return async function* (request) {
		for (const event of events) yield event;
		await untilAbort(request.signal);
	};
}

export function failWith(error: Error, ...events: ChatEvent[]): Script {
	return async function* () {
		for (const event of events) yield event;
		throw error;
	};
}

export type ScriptedProvider = FakeProvider & {
	subscribeRequests: SubscribeRequest[];
	resolveRequests: Parameters<ChatProvider["resolveChat"]>[0][];
	resolveError?: Error;
	resolveSeenPidfile: boolean[];
};

export function createScriptedProvider(
	script: Script,
	reactionIds: string[],
	pidPath: string,
): ScriptedProvider {
	const base = createFakeProvider({ reactionIds });
	const provider = base as ScriptedProvider;
	provider.subscribeRequests = [];
	provider.resolveRequests = [];
	provider.resolveSeenPidfile = [];
	provider.resolveChat = async (query) => {
		provider.resolveRequests.push(query);
		provider.resolveSeenPidfile.push(existsSync(pidPath));
		if (provider.resolveError) throw provider.resolveError;
		return { id: query.chatId ?? CHAT_ID, topic: "Team Reviews" };
	};
	provider.subscribe = (request) => {
		provider.subscribeRequests.push(request);
		return script(request);
	};
	return provider;
}

export type FakePlatform = PlatformSeam & {
	alive: Set<number>;
	argsByPid: Map<number, string>;
	signals: { pid: number; signal: NodeJS.Signals | 0 }[];
	killed: number[];
	listed: number[];
	epermPids: Set<number>;
	onSignal?: (pid: number, signal: NodeJS.Signals | 0) => void;
};

export function createFakePlatform(
	platform: NodeJS.Platform = "linux",
): FakePlatform {
	const fake: FakePlatform = {
		platform,
		alive: new Set(),
		argsByPid: new Map(),
		signals: [],
		killed: [],
		listed: [],
		epermPids: new Set(),
		listArgs(pid) {
			fake.listed.push(pid);
			return fake.argsByPid.get(pid) ?? "";
		},
		startTime: (pid) => `start-${pid}`,
		killTree(pid) {
			fake.killed.push(pid);
			fake.alive.delete(pid);
		},
		signal(pid, signal) {
			fake.signals.push({ pid, signal });
			fake.onSignal?.(pid, signal);
			if (fake.epermPids.has(pid)) {
				throw Object.assign(new Error("EPERM"), { code: "EPERM" });
			}
			if (!fake.alive.has(pid)) {
				throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
			}
		},
	};
	return fake;
}

export function termSignals(platform: FakePlatform) {
	return platform.signals.filter((entry) => entry.signal !== 0);
}

export type FakeChild = ChildLike &
	EventEmitter & { killCalls: (NodeJS.Signals | undefined)[]; unrefCalls: number };

export function createFakeChild(pid: number): FakeChild {
	const emitter = new EventEmitter() as FakeChild;
	emitter.pid = pid;
	emitter.exitCode = null;
	emitter.killCalls = [];
	emitter.unrefCalls = 0;
	emitter.unref = () => {
		emitter.unrefCalls += 1;
	};
	emitter.kill = (signal) => {
		emitter.killCalls.push(signal);
		return true;
	};
	return emitter;
}

export type DaemonIoRecorder = DaemonIo & {
	outLines: string[];
	errLines: string[];
	all(): string;
};

export function createIo(): DaemonIoRecorder {
	const io: DaemonIoRecorder = {
		outLines: [],
		errLines: [],
		out: (line) => {
			io.outLines.push(line);
		},
		err: (line) => {
			io.errLines.push(line);
		},
		all: () => [...io.outLines, ...io.errLines].join("\n"),
	};
	return io;
}

export type DaemonHarnessOptions = {
	envName?: "dev" | "prod";
	configExtra?: Record<string, unknown>;
	writeConfig?: boolean;
	runnerScript?: RunnerScript;
	scripts?: Script[];
	platform?: NodeJS.Platform;
	resolveError?: Error;
	listedReactions?: string[];
};

export function createDaemonHarness(options: DaemonHarnessOptions = {}) {
	const home = createTempHome();
	const system: SystemSeams = {
		platform: "linux",
		homeDir: home.dir,
		env: { ...process.env, DG_HOME: home.dir },
	};
	const envName = options.envName ?? "dev";
	const pathsFor = (name: "dev" | "prod") => channelReviewPaths(name, system);
	const paths: ChannelReviewPaths = pathsFor(envName);
	mkdirSync(dirname(paths.configPath), { recursive: true });
	if (options.writeConfig !== false) {
		writeFileSync(
			paths.configPath,
			`${JSON.stringify(minimalConfigJson(options.configExtra), null, "\t")}\n`,
		);
	}
	const config: ChannelConfig | undefined =
		options.writeConfig === false ? undefined : loadConfig(paths.configPath);
	const reactionIds = config
		? [
				...Object.values(config.reactions),
				...loadFunPool().flatMap((entry) =>
					entry.kind === "emoji" ? [entry.reactionId] : [],
				),
			]
		: [];
	const env = config ? resolveEnv(config, envName) : undefined;
	const platform = createFakePlatform(options.platform);
	const log = createRecordedLog();
	const io = createIo();
	const providers: ScriptedProvider[] = [];
	const secrets: string[] = [];
	const providerSecrets: string[] = [];
	const fetchSecretCalls: unknown[] = [];
	const runners: Record<RunnerName, FakeRunner> = {
		claude: createFakeRunner("claude", options.runnerScript),
		codex: createFakeRunner("codex", options.runnerScript),
		copilot: createFakeRunner("copilot", options.runnerScript),
	};
	const verdict = createFakeVerdictReader();
	const stack = createFakeStackReader();

	const seams: DaemonSeams = {
		fetchSecret: async (params) => {
			fetchSecretCalls.push(params);
			const secret = `secret-${secrets.length + 1}`;
			secrets.push(secret);
			return secret;
		},
		createProvider: (_config, _env, providerSeams) => {
			providerSecrets.push(providerSeams.secret);
			const provider = createScriptedProvider(
				options.scripts?.[providers.length] ?? holdOpen(),
				options.listedReactions ?? reactionIds,
				paths.pidPath,
			);
			provider.resolveError = options.resolveError;
			providers.push(provider);
			return provider;
		},
		runners,
		verdict,
		stack,
		random: () => 0,
		probeTimeoutMs: 50,
		stopTimeoutMs: 10_000,
	};

	const controllers: AbortController[] = [];
	const running: Promise<number>[] = [];

	function readJson(path: string): Record<string, unknown> {
		return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	}

	return {
		home,
		system,
		paths,
		pathsFor,
		config: config as ChannelConfig,
		env: env as NonNullable<typeof env>,
		reactionIds,
		platform,
		log,
		io,
		providers,
		provider: () => providers[providers.length - 1] as ScriptedProvider,
		secrets,
		providerSecrets,
		fetchSecretCalls,
		runners,
		verdict,
		stack,
		seams,
		readJson,
		readPidfile: () => readJson(paths.pidPath),
		readState: () => readJson(paths.statePath),
		seedState(mutate: (store: ReturnType<typeof createStateStore>) => void) {
			const store = createStateStore(paths.statePath);
			mutate(store);
			store.flush();
		},
		writePidfile(pid: number, name: "dev" | "prod" = envName) {
			const path = pathsFor(name).pidPath;
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(
				path,
				JSON.stringify({
					pid,
					env: name,
					startedAt: "2026-10-14T12:00:00.000Z",
					chats: [{ id: CHAT_ID, topic: "Team Reviews" }],
				}),
			);
		},
		startServe(overrides: { runner?: RunnerName; chatId?: string } = {}) {
			const controller = new AbortController();
			controllers.push(controller);
			const done = serve({
				config: config as ChannelConfig,
				env: env as NonNullable<typeof env>,
				paths,
				overrides,
				log,
				seams,
				platform,
				signal: controller.signal,
			});
			running.push(done);
			return { controller, done };
		},
		async cleanup() {
			for (const controller of controllers) controller.abort();
			await Promise.allSettled(running);
			home.cleanup();
		},
	};
}

export type DaemonHarness = ReturnType<typeof createDaemonHarness>;
