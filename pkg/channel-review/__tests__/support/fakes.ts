import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressWorkspace, PrHead } from "../../src/address";
import { loadConfig } from "../../src/config";
import { createEngine } from "../../src/engine";
import { channelReviewPaths } from "../../src/paths";
import type { Log } from "../../src/engine";
import type { CrCode } from "../../src/errors";
import { FUN_VERDICTS } from "../../src/fun";
import type { FunEntry, FunVerdict } from "../../src/fun";
import type {
	AdaptiveCard,
	ChatEvent,
	ChatMessage,
	ChatProvider,
} from "../../src/providers/types";
import type { Runner, RunnerName } from "../../src/runners/types";
import { createStateStore } from "../../src/state";
import type { StateStore } from "../../src/state";
import type { ErrorSink, SinkIssue } from "../../src/sinks/types";
import type { CaptureFn } from "../../src/verdict/cli";
import { VerdictError } from "../../src/verdict/types";
import type {
	StackReader,
	Verdict,
	VerdictReader,
} from "../../src/verdict/types";

export const CHAT_ID = "chat-1";
export const PR_URL = "https://github.com/o/r/pull/12";
export const SENDER_EMAIL = "owner@example.com";
export const BOT_NAME = "Review Bot";
export const OWNER_TOKEN = "!owner";
export const APP_NAME = "review-bot";
export const RELAY_SECRET = { id: "relay/chat", key: "RELAY__CHAT__SECRET", region: "us-east-1" };
export const ENVS = {
	dev: { baseUrl: "https://relay.example.test/dev/api", awsProfile: "example-dev", botName: BOT_NAME },
	prod: {
		baseUrl: "https://relay.example.test/prod/api",
		awsProfile: "example-prod",
		botName: "Review Bot (Prod)",
	},
};

export type Config = ReturnType<typeof loadConfig>;
export type RunnerRun = Parameters<Runner["run"]>[0];
export type RunnerResult = Awaited<ReturnType<Runner["run"]>>;
export type ProbeResult = Awaited<ReturnType<Runner["probe"]>>;

export type TempHome = {
	dir: string;
	env: Record<string, string>;
	cleanup(): void;
};

export function createTempHome(): TempHome {
	const dir = mkdtempSync(join(tmpdir(), "channel-review-"));
	return {
		dir,
		env: { DG_HOME: dir },
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

export function minimalConfigJson(
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		envs: ENVS,
		...(extra.chat === undefined && { chats: [{ topic: "Team Reviews" }] }),
		owner: { token: OWNER_TOKEN, email: SENDER_EMAIL },
		relay: { appName: APP_NAME, secret: RELAY_SECRET },
		...extra,
	};
}

export function writeConfigFile(
	dir: string,
	body: Record<string, unknown> = minimalConfigJson(),
	name = "config.json",
): string {
	const path = join(dir, name);
	writeFileSync(path, `${JSON.stringify(body, null, "\t")}\n`);
	return path;
}

export type Deferred<T> = {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(reason: unknown): void;
};

export function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

export async function waitUntil(
	predicate: () => boolean,
	timeoutMs = 2000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("waitUntil timed out");
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

export type FixedClock = (() => Date) & { advance(ms: number): void };

export function createFixedClock(
	startIso = "2026-10-14T12:00:00.000Z",
): FixedClock {
	let current = Date.parse(startIso);
	const clock = (() => new Date(current)) as FixedClock;
	clock.advance = (ms) => {
		current += ms;
	};
	return clock;
}

export function createRandom(values: number[]): () => number {
	let index = 0;
	return () => values[index++ % values.length] ?? 0;
}

export type ProviderCall =
	| { op: "react"; chatId: string; messageId: string; reactionId: string }
	| { op: "unreact"; chatId: string; messageId: string; reactionId: string }
	| { op: "reply"; chatId: string; text: string; html?: boolean; card?: AdaptiveCard };

export type DmCall = { text: string; html?: boolean };

export type FakeProvider = ChatProvider & {
	calls: ProviderCall[];
	dms: DmCall[];
	failReplies: boolean;
	failReactions: boolean;
	onCall?: (call: ProviderCall) => void;
	replies(): Extract<ProviderCall, { op: "reply" }>[];
};

export function createFakeProvider(
	options: { events?: ChatEvent[]; reactionIds?: string[] } = {},
): FakeProvider {
	let sent = 0;
	const provider: FakeProvider = {
		calls: [],
		dms: [],
		failReplies: false,
		failReactions: false,
		replies: () =>
			provider.calls.filter(
				(call): call is Extract<ProviderCall, { op: "reply" }> =>
					call.op === "reply",
			),
		resolveChat: async ({ chatId }) => ({ id: chatId ?? CHAT_ID }),
		subscribe: async function* () {
			for (const event of options.events ?? []) yield event;
		},
		react: async ({ chatId, messageId, reactionId }) => {
			const call: ProviderCall = { op: "react", chatId, messageId, reactionId };
			provider.calls.push(call);
			provider.onCall?.(call);
			if (provider.failReactions) throw new Error("react failed");
		},
		unreact: async ({ chatId, messageId, reactionId }) => {
			const call: ProviderCall = {
				op: "unreact",
				chatId,
				messageId,
				reactionId,
			};
			provider.calls.push(call);
			provider.onCall?.(call);
			if (provider.failReactions) throw new Error("unreact failed");
		},
		reply: async ({ chatId, text, html, card }) => {
			const call: ProviderCall = { op: "reply", chatId, text, card, ...(html && { html }) };
			provider.calls.push(call);
			provider.onCall?.(call);
			if (provider.failReplies) throw new Error("reply failed");
			sent += 1;
			return { messageIds: [`sent-${sent}`] };
		},
		dm: async ({ text, html }) => {
			provider.dms.push({ text, ...(html && { html }) });
			if (provider.failReplies) throw new Error("dm failed");
			sent += 1;
			return { messageIds: [`sent-${sent}`] };
		},
		listReactions: async () => options.reactionIds ?? [],
	};
	return provider;
}


export const OK_RESULT: RunnerResult = {
	status: 0,
	signal: null,
	timedOut: false,
	aborted: false,
};

export type RunnerScript = (
	run: RunnerRun,
	index: number,
) => Promise<RunnerResult> | RunnerResult;

export type FakeRunner = Runner & {
	runs: RunnerRun[];
	active: number;
	maxActive: number;
	probeResult: ProbeResult;
	probeCalls: number;
};

export function createFakeRunner(
	name: RunnerName,
	script: RunnerScript = () => OK_RESULT,
): FakeRunner {
	const runner: FakeRunner = {
		name,
		runs: [],
		active: 0,
		maxActive: 0,
		probeCalls: 0,
		probeResult: { ok: true },
		probe: async () => {
			runner.probeCalls += 1;
			return runner.probeResult;
		},
		run: async (run) => {
			const index = runner.runs.length;
			runner.runs.push(run);
			runner.active += 1;
			runner.maxActive = Math.max(runner.maxActive, runner.active);
			try {
				return await script(run, index);
			} finally {
				runner.active -= 1;
			}
		},
	};
	return runner;
}

export function abortable(
	run: RunnerRun,
	gate: Promise<RunnerResult>,
): Promise<RunnerResult> {
	return new Promise((resolve) => {
		void gate.then(resolve);
		run.signal.addEventListener(
			"abort",
			() =>
				resolve({ status: null, signal: "SIGTERM", timedOut: false, aborted: true }),
			{ once: true },
		);
	});
}

export type VerdictRequest = Parameters<VerdictReader["read"]>[0];
export type VerdictScript = (
	request: VerdictRequest,
	index: number,
) => Promise<Verdict> | Verdict;

export type FakeVerdictReader = VerdictReader & {
	reads: VerdictRequest[];
	probeResult: Awaited<ReturnType<VerdictReader["probe"]>>;
	probedHosts: string[];
	probes: { host: string; url?: string }[];
};

export function createFakeVerdictReader(
	script: VerdictScript = () => "approved",
): FakeVerdictReader {
	const reader: FakeVerdictReader = {
		reads: [],
		probedHosts: [],
		probes: [],
		probeResult: { ok: true },
		probe: async (request) => {
			reader.probes.push(request);
			reader.probedHosts.push(request.host);
			return reader.probeResult;
		},
		read: async (request) => {
			const index = reader.reads.length;
			reader.reads.push(request);
			return script(request, index);
		},
	};
	return reader;
}

export type FakeStackReader = StackReader & {
	requests: Parameters<StackReader["descendants"]>[0][];
	failWith?: CrCode;
};

export function createFakeStackReader(
	descendantsByUrl: Record<string, { number: number; url: string }[]> = {},
): FakeStackReader {
	const reader: FakeStackReader = {
		requests: [],
		descendants: async (request) => {
			reader.requests.push(request);
			if (reader.failWith) throw new VerdictError(reader.failWith);
			return descendantsByUrl[request.url] ?? [];
		},
	};
	return reader;
}

export type FakeWorkspace = AddressWorkspace & {
	heads: Parameters<AddressWorkspace["head"]>[0][];
	clones: Parameters<AddressWorkspace["clone"]>[0][];
	nextHead: PrHead;
	headError?: CrCode;
	cloneError?: CrCode;
};

export function createFakeWorkspace(): FakeWorkspace {
	const workspace: FakeWorkspace = {
		heads: [],
		clones: [],
		nextHead: { name: "github.com-o-r", branch: "feature", fork: false },
		head: async (request) => {
			workspace.heads.push(request);
			if (workspace.headError) throw new VerdictError(workspace.headError);
			return workspace.nextHead;
		},
		clone: async (request) => {
			workspace.clones.push(request);
			if (workspace.cloneError) throw new VerdictError(workspace.cloneError);
			mkdirSync(request.dir, { recursive: true });
			writeFileSync(join(request.dir, "README.md"), "clone\n");
		},
	};
	return workspace;
}

export type CaptureCall = { command: string; args: string[] };
export type CaptureReply = { status: number; stdout?: string; stderr?: string };

export type FakeCapture = { calls: CaptureCall[]; runner: CaptureFn };

export function createFakeCapture(
	reply: (call: CaptureCall) => CaptureReply | Promise<CaptureReply> = () => ({ status: 0 }),
): FakeCapture {
	const calls: CaptureCall[] = [];
	const runner = (async (command: string, args: string[]) => {
		const call = { command, args };
		calls.push(call);
		const { status, stdout = "", stderr = "" } = await reply(call);
		return { status, signal: null, stdout, stderr };
	}) as CaptureFn;
	return { calls, runner };
}

export type FakeSink = ErrorSink & {
	polls: Parameters<ErrorSink["poll"]>[0][];
	details: SinkIssue[];
	issues: SinkIssue[];
	cursor?: string;
	failPoll?: Error;
};

export function createFakeSink(name = "fake"): FakeSink {
	const sink: FakeSink = {
		name,
		polls: [],
		details: [],
		issues: [],
		poll: async (request) => {
			sink.polls.push(request);
			if (sink.failPoll) throw sink.failPoll;
			return { issues: sink.issues, cursor: sink.cursor };
		},
		detail: async (issue) => {
			sink.details.push(issue);
			return { ...issue, message: `${issue.title} message` };
		},
	};
	return sink;
}

export function buildIssue(id: string, overrides: Partial<SinkIssue> = {}): SinkIssue {
	return {
		id,
		title: `Error ${id}`,
		service: "example-api",
		env: "prod",
		level: "error",
		firstSeen: "2026-10-14T11:00:00.000Z",
		lastSeen: "2026-10-14T11:30:00.000Z",
		link: `https://errors.example.com/issues/${id}`,
		regressed: false,
		...overrides,
	};
}

export type RecordedLog = Log & {
	lines: { level: "info" | "warn" | "error"; message: string }[];
};

export function createRecordedLog(): RecordedLog {
	const lines: RecordedLog["lines"] = [];
	const at =
		(level: "info" | "warn" | "error") =>
		(message: string): void => {
			lines.push({ level, message });
		};
	return { lines, info: at("info"), warn: at("warn"), error: at("error") };
}

export function gifEntry(verdict: FunVerdict, n = 1): FunEntry {
	return {
		verdict,
		kind: "gif",
		url: `https://img.example.com/${verdict}-${n}.gif`,
		alt: `${verdict} gif ${n}`,
	};
}

export function emojiEntry(verdict: FunVerdict, n = 1): FunEntry {
	return {
		verdict,
		kind: "emoji",
		reactionId: `${verdict}${n}_reaction`,
		text: `${verdict}-emoji-${n}`,
	};
}

export function completeFunPool(): FunEntry[] {
	return FUN_VERDICTS.flatMap((verdict) => [
		gifEntry(verdict),
		emojiEntry(verdict),
	]);
}

export function buildMessage(
	id: string,
	text: string,
	overrides: Partial<ChatMessage> = {},
): ChatMessage {
	return {
		id,
		chatId: CHAT_ID,
		from: { id: "u-1", name: "Owner", isBot: false },
		text,
		timestamp: "2026-10-14T12:00:00.000Z",
		...overrides,
	};
}

export function reviewText(url: string, tokens = ""): string {
	return `<p><at>${BOT_NAME}</at> !owner $review <a href="${url}">PR</a> ${tokens}</p>`.trim();
}

export const OWNER_ID = "u-owner";
export const OTHER_ID = "u-other";

export function addressMessage(
	id: string,
	url = PR_URL,
	tokens = "",
	senderId = OWNER_ID,
): ChatMessage {
	return buildMessage(
		id,
		`<p><at>${BOT_NAME}</at> !owner $address <a href="${url}">PR</a> ${tokens}</p>`.trim(),
		{ from: { id: senderId, name: "Owner", isBot: false } },
	);
}

export function reviewMessage(
	id: string,
	url = PR_URL,
	tokens = "",
): ChatMessage {
	return buildMessage(id, reviewText(url, tokens));
}

export type HarnessOptions = {
	configExtra?: Record<string, unknown>;
	runnerScript?: RunnerScript;
	verdictScript?: VerdictScript;
	descendants?: Record<string, { number: number; url: string }[]>;
	funPool?: FunEntry[];
	random?: () => number;
	persistError?: Error;
};

export type EngineHarness = ReturnType<typeof createEngineHarness>;

export function createEngineHarness(options: HarnessOptions = {}) {
	const home = createTempHome();
	const config = loadConfig(
		writeConfigFile(
			home.dir,
			minimalConfigJson({
				owner: { token: OWNER_TOKEN, email: SENDER_EMAIL, senderIds: [OWNER_ID] },
				address: { cloneRoot: join(home.dir, "clones") },
				...options.configExtra,
			}),
		),
	);
	const paths = channelReviewPaths("dev", {
		platform: "linux",
		homeDir: home.dir,
		env: home.env,
	});
	const provider = createFakeProvider();
	const runners: Record<RunnerName, FakeRunner> = {
		claude: createFakeRunner("claude", options.runnerScript),
		codex: createFakeRunner("codex", options.runnerScript),
		copilot: createFakeRunner("copilot", options.runnerScript),
	};
	const verdict = createFakeVerdictReader(options.verdictScript);
	const stack = createFakeStackReader(options.descendants);
	const workspace = createFakeWorkspace();
	const clock = createFixedClock();
	const state: StateStore = createStateStore(paths.statePath, clock);
	const log = createRecordedLog();
	const persisted: { slot: string; id: string }[] = [];
	const timers: { ms: number; task: () => Promise<void>; canceled: boolean }[] = [];
	const engine = createEngine({
		botName: BOT_NAME,
		provider,
		paths,
		runners,
		verdict,
		stack,
		workspace,
		state,
		config,
		defaultChatId: CHAT_ID,
		funPool: options.funPool ?? [],
		random: options.random ?? (() => 0),
		log,
		clock,
		startTime: (pid) => `start-${pid}`,
		persistReaction: (slot, id) => {
			if (options.persistError) throw options.persistError;
			persisted.push({ slot, id });
		},
		schedule: (ms, task) => {
			const timer = { ms, task, canceled: false };
			timers.push(timer);
			return () => {
				timer.canceled = true;
			};
		},
	});

	const reactionNames = new Map<string, string>(
		Object.entries(config.reactions).map(([name, id]) => [id as string, name]),
	);

	function trail(messageId: string): string[] {
		return provider.calls.flatMap((call) => {
			if (call.op === "reply" || call.messageId !== messageId) return [];
			const name = reactionNames.get(call.reactionId) ?? call.reactionId;
			return [`${call.op === "react" ? "+" : "-"}${name}`];
		});
	}

	return {
		home,
		paths,
		config,
		provider,
		runners,
		runner: runners.claude,
		verdict,
		stack,
		workspace,
		state,
		clock,
		log,
		engine,
		persisted,
		timers,
		trail,
		replies: () => provider.replies(),
		cleanup: () => home.cleanup(),
	};
}
