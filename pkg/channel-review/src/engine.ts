import { join } from "node:path";
import { createSerialQueue, describeError } from "@dg/common";
import {
	type AddressWorkspace,
	cloneDirName,
	errorCode,
	removeCloneDir,
	removeLeftoverClones,
} from "./address";
import { ensurePrivateDir } from "@dg/common/node";
import { type ChannelConfig, resolveReactionSlot } from "./config";
import { createNotifier } from "./automation/notify";
import { sweepCloneRoot } from "./automation/repo-job";
import { type CrCode, ownerName, replyText } from "./errors";
import { type FunEntry, decorateReply, funVerdictFor, pickFun } from "./fun";
import { EMOJI_WAIT_MINUTES, helpText } from "./help";
import { pruneJobLogs } from "./job-logs";
import type { ChannelReviewPaths } from "./paths";
import type { ChatMessage, ChatProvider, ChatReaction } from "./providers/types";
import { capturedReactionId, REACTION_STATES, type ReactionState, transition } from "./reactions";
import { RUNNER_NAMES, type RunTask, type Runner, type RunnerName } from "./runners/types";
import { type BlockedOptions, type StateStore, prKey } from "./state";
import {
	type StackRow,
	VERDICT_LABELS,
	aggregateOutcome,
	formatStackSummary,
	outcomeOf,
} from "./summary";
import { type HelpTopic, parsePrUrl, parseReadiness, parseTrigger } from "./trigger";
import {
	type PrHost,
	type StackReader,
	VerdictError,
	type VerdictReader,
} from "./verdict/types";

export type Log = {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
};

export type ProcessSeam = {
	isAlive(pid: number): boolean;
	listArgs(pid: number): string;
	startTime(pid: number): string | undefined;
	killTree(pid: number): void | Promise<void>;
};

export type EngineDeps = {
	provider: ChatProvider;
	paths: ChannelReviewPaths;
	runners: Record<RunnerName, Runner>;
	verdict: VerdictReader;
	stack: StackReader;
	workspace: AddressWorkspace;
	state: StateStore;
	config: ChannelConfig;
	defaultChatId: string;
	botName: string;
	funPool: FunEntry[];
	random: () => number;
	log: Log;
	clock: () => Date;
	startTime: (pid: number) => string | undefined;
	persistReaction: (slot: ReactionState, id: string) => void;
	schedule?: (ms: number, task: () => Promise<void>) => () => void;
};

export type RepoJobHost = {
	signal: AbortSignal;
	runAgent(request: {
		task: Extract<RunTask, { task: "fix" }>;
		cwd: string;
		timeoutMs: number;
		logName: string;
		signal: AbortSignal;
	}): Promise<CrCode | null>;
};

export type RepoJob = {
	kind: "repo";
	id: string;
	url: string;
	work(host: RepoJobHost): Promise<void>;
};

export type Engine = {
	handle(message: ChatMessage): Promise<void>;
	handleReaction(reaction: ChatReaction): Promise<void>;
	recover(seam: ProcessSeam): Promise<void>;
	enqueueRepo(job: Omit<RepoJob, "kind">): boolean;
	maintain(): void;
	stop(): Promise<void>;
	idle(): Promise<void>;
};

type JobBase = {
	messageId: string;
	chatId: string;
	url: string;
	number: number;
	host: PrHost;
};

type AddressJob = JobBase & { kind: "address"; noCi: boolean };

type ReviewJob = JobBase & {
	kind: "review";
	spice?: number;
	comment: boolean;
	fun: boolean;
	stacked: boolean;
	agent?: RunnerName;
};

type Job = AddressJob | ReviewJob;

type Outcome = StackRow["outcome"];
type Target = { number: number; url: string };
type PendingEmoji = {
	slot: ReactionState;
	chatId: string;
	messageIds: string[];
	since: number;
	cancel: () => void;
};
type GatedCommand = "$address" | "$emoji";

const EMOJI_WAIT_MS = EMOJI_WAIT_MINUTES * 60_000;

function scheduleTimer(ms: number, task: () => Promise<void>): () => void {
	const timer = setTimeout(() => void task(), ms);
	return () => clearTimeout(timer);
}

const RUNNER_PROCESS = new RegExp(`\\b(${RUNNER_NAMES.join("|")})\\b`, "i");

export function createEngine(deps: EngineDeps): Engine {
	const { provider, paths, runners, verdict, stack, workspace, state, config, defaultChatId } = deps;
	const { funPool, random, log, clock, startTime, botName, persistReaction } = deps;
	const schedule = deps.schedule ?? scheduleTimer;
	const reactionIds = config.reactions satisfies Record<ReactionState, string>;
	const timeoutMs = config.runner.timeoutMinutes * 60_000;
	const addressTimeoutMs = config.runner.addressTimeoutMinutes * 60_000;
	const owner = ownerName(config.owner.token);
	const notify = createNotifier({ provider, config, log });
	const longestTimeoutMs =
		Math.max(
			config.runner.timeoutMinutes,
			config.runner.addressTimeoutMinutes,
			config.errorWatch.autoFix.timeoutMinutes,
			config.deps.timeoutMinutes,
		) * 60_000;
	const reactionState = new Map<string, ReactionState>();
	const inFlight = new Set<string>();
	const enqueue = createSerialQueue((err) =>
		log.error(`job failed unexpectedly: ${describeError(err)}`),
	);
	let tail: Promise<void> = Promise.resolve();
	let stopped = false;
	let active: AbortController | null = null;
	let pendingEmoji: PendingEmoji | null = null;

	async function attempt(label: string, action: () => Promise<unknown>): Promise<void> {
		try {
			await action();
		} catch (err) {
			log.warn(`${label} failed: ${describeError(err)}`);
		}
	}

	async function move(
		chatId: string,
		messageId: string,
		to: ReactionState,
		from: ReactionState | null = reactionState.get(messageId) ?? null,
	): Promise<void> {
		for (const { op, reactionId } of transition(from, to, reactionIds)) {
			const request = { chatId, messageId, reactionId };
			await attempt(`${op} reaction ${reactionId}`, () =>
				op === "put" ? provider.react(request) : provider.unreact(request),
			);
		}
		reactionState.set(messageId, to);
	}

	async function send(chatId: string, text: string): Promise<string[]> {
		let sent: string[] = [];
		await attempt("reply", async () => {
			({ messageIds: sent } = await provider.reply({ chatId, text }));
		});
		return sent;
	}

	async function post(
		chatId: string,
		text: string,
		outcome: ReturnType<typeof outcomeOf>,
		fun: boolean,
	): Promise<void> {
		const entry = fun ? pickFun(funPool, funVerdictFor(outcome), random) : undefined;
		const body = entry ? decorateReply({ text, entry }) : { text };
		await attempt("reply", () => provider.reply({ chatId, ...body }));
	}

	async function fail(job: Job, code: CrCode, agent: string): Promise<void> {
		log.info(`message ${job.messageId} failed: ${code} ${job.url}`);
		state.markHandled(job.messageId, "failed", job.chatId);
		await move(job.chatId, job.messageId, "failure");
		await post(
			job.chatId,
			replyText(code, {
				agent,
				minutes:
					job.kind === "address"
						? config.runner.addressTimeoutMinutes
						: config.runner.timeoutMinutes,
				owner,
			}),
			"failure",
			job.kind === "review" && job.fun,
		);
	}

	function settleBlocked(job: ReviewJob, target: Target, outcome: Outcome): void {
		const key = prKey(target.url);
		if (outcome === "changes_requested") {
			const options: BlockedOptions = {
				spice: job.spice,
				comment: job.comment,
				fun: job.fun,
				agent: job.agent,
			};
			state.markBlocked(target.url, job.messageId, options, job.chatId);
		} else if (state.get().blocked[key] && (typeof outcome === "string" || outcome.code === "CR-302")) {
			state.clearBlocked(target.url);
		}
	}

	async function execute(
		job: Pick<JobBase, "messageId" | "chatId">,
		target: Target,
		run: { task: RunTask; cwd: string; timeoutMs: number; logName: string },
		runner: Runner,
		signal: AbortSignal,
	): Promise<CrCode | null> {
		if (signal.aborted) return "CR-205";
		state.setCurrent({
			messageId: job.messageId,
			chatId: job.chatId,
			url: target.url,
			number: target.number,
			startedAt: clock().toISOString(),
		});
		let result: Awaited<ReturnType<Runner["run"]>>;
		try {
			result = await runner.run({
				...run.task,
				cwd: run.cwd,
				timeoutMs: run.timeoutMs,
				logPath: join(paths.jobsDir, `${run.logName}.log`),
				signal,
				onSpawn: (pid) => {
					const current = state.get().current;
					if (current) state.setCurrent({ ...current, pid, pidStart: startTime(pid) });
				},
			});
		} catch (err) {
			log.error(`runner ${runner.name} threw: ${describeError(err)}`);
			return "CR-203";
		}
		if (result.aborted) return "CR-205";
		if (result.timedOut) return "CR-204";
		if (result.code) return result.code;
		return result.status === 0 ? null : "CR-203";
	}

	async function review(
		job: ReviewJob,
		target: Target,
		logName: string,
		runner: Runner,
		signal: AbortSignal,
	): Promise<Outcome> {
		const startedAt = clock();
		const failed = await execute(
			job,
			target,
			{
				task: { task: "thrash", url: target.url, spice: job.spice, comment: job.comment },
				cwd: paths.workDir,
				timeoutMs,
				logName,
			},
			runner,
			signal,
		);
		if (failed) return { code: failed };
		try {
			const read = await verdict.read({ url: target.url, host: job.host, since: startedAt });
			return read === "none" ? { code: "CR-301" } : read;
		} catch (err) {
			if (err instanceof VerdictError) return { code: err.code };
			log.error(`verdict read threw: ${describeError(err)}`);
			return { code: "CR-203" };
		}
	}

	async function preflight(runner: Runner, job: Job): Promise<CrCode | null> {
		const runnerProbe = await runner.probe();
		if (!runnerProbe.ok) return runnerProbe.code;
		const verdictProbe = await verdict.probe({ host: job.host, url: job.url });
		return verdictProbe.ok ? null : verdictProbe.code;
	}

	async function reviewSingle(job: ReviewJob, runner: Runner, signal: AbortSignal): Promise<void> {
		const target = { number: job.number, url: job.url };
		const outcome = await review(job, target, job.messageId, runner, signal);
		settleBlocked(job, target, outcome);
		if (typeof outcome !== "string") return fail(job, outcome.code, runner.name);

		const label = VERDICT_LABELS[outcome];
		log.info(`message ${job.messageId} done: ${outcome} ${job.url}`);
		state.markHandled(job.messageId, "done", job.chatId);
		await move(job.chatId, job.messageId, outcomeOf(outcome));
		if (job.fun) {
			await post(job.chatId, `${label.emoji} ${label.word} #${job.number} ${job.url}`, outcomeOf(outcome), true);
		}
	}

	async function reviewStack(job: ReviewJob, runner: Runner, signal: AbortSignal): Promise<void> {
		let descendants: Target[];
		try {
			descendants = await stack.descendants({ url: job.url, host: job.host });
		} catch (err) {
			const code = err instanceof VerdictError ? err.code : "CR-304";
			if (!(err instanceof VerdictError)) {
				log.error(`stack read threw: ${describeError(err)}`);
			}
			return fail(job, code, runner.name);
		}

		const rows: StackRow[] = [];
		for (const target of [{ number: job.number, url: job.url }, ...descendants]) {
			const outcome = signal.aborted
				? ({ code: "CR-205" } as const)
				: await review(job, target, `${job.messageId}-${target.number}`, runner, signal);
			if (typeof outcome !== "string" && outcome.code === "CR-205") {
				return fail(job, "CR-205", runner.name);
			}
			settleBlocked(job, target, outcome);
			rows.push({ ...target, outcome });
		}

		const aggregate = aggregateOutcome(rows);
		log.info(`message ${job.messageId} stacked review done: ${aggregate}, ${rows.length} PRs`);
		state.markHandled(job.messageId, aggregate === "failure" ? "failed" : "done", job.chatId);
		await move(job.chatId, job.messageId, aggregate);
		await post(job.chatId, formatStackSummary(rows), aggregate, job.fun);
	}

	async function address(job: AddressJob, signal: AbortSignal): Promise<void> {
		const runner = runners.claude;
		const probe = await verdict.probe({ host: job.host, url: job.url });
		if (!probe.ok) return fail(job, probe.code, runner.name);
		if (signal.aborted) return fail(job, "CR-205", runner.name);

		let head: Awaited<ReturnType<AddressWorkspace["head"]>>;
		try {
			head = await workspace.head({ url: job.url, host: job.host });
		} catch (err) {
			log.warn(`message ${job.messageId} PR head read failed: ${describeError(err)}`);
			return fail(job, errorCode(err, "CR-302"), runner.name);
		}
		if (head.fork) return fail(job, "CR-305", runner.name);

		const root = config.address.cloneRoot;
		const dir = join(root, cloneDirName(head, job.messageId));
		let failed: CrCode | null;
		try {
			try {
				await workspace.clone({ url: job.url, host: job.host, branch: head.branch, dir });
				failed = await execute(
					job,
					job,
					{
						task: { task: "address", noCi: job.noCi },
						cwd: dir,
						timeoutMs: addressTimeoutMs,
						logName: job.messageId,
					},
					runner,
					signal,
				);
			} catch (err) {
				log.warn(`message ${job.messageId} clone failed: ${describeError(err)}`);
				failed = errorCode(err, "CR-306");
			}
		} finally {
			removeCloneDir(root, dir, log);
		}
		if (failed) return fail(job, failed, runner.name);

		log.info(`message ${job.messageId} addressed: ${job.url}`);
		state.markHandled(job.messageId, "done", job.chatId);
		await move(job.chatId, job.messageId, "approved");
	}

	async function runJob(job: Job): Promise<void> {
		if (stopped) return;
		const controller = new AbortController();
		active = controller;
		const runner = runners[job.kind === "address" ? "claude" : (job.agent ?? config.runner.default)];
		try {
			state.markHandled(job.messageId, "running", job.chatId);
			await move(job.chatId, job.messageId, "inProgress");
			ensurePrivateDir(paths.jobsDir);
			ensurePrivateDir(paths.workDir);

			if (job.kind === "address") {
				await address(job, controller.signal);
				return;
			}
			const blocker = await preflight(runner, job);
			if (blocker) await fail(job, blocker, runner.name);
			else if (job.stacked) await reviewStack(job, runner, controller.signal);
			else await reviewSingle(job, runner, controller.signal);
		} catch (err) {
			log.error(`job ${job.messageId} failed unexpectedly: ${describeError(err)}`);
			await fail(job, "CR-203", runner.name);
		} finally {
			state.setCurrent(null);
			reactionState.delete(job.messageId);
			inFlight.delete(prKey(job.url));
			active = null;
		}
	}

	async function runRepoJob(job: RepoJob): Promise<void> {
		if (stopped) {
			inFlight.delete(job.id);
			return;
		}
		const controller = new AbortController();
		active = controller;
		try {
			ensurePrivateDir(paths.jobsDir);
			await job.work({
				signal: controller.signal,
				runAgent: ({ task, cwd, timeoutMs: agentTimeoutMs, logName, signal }) =>
					execute(
						{ messageId: job.id, chatId: defaultChatId },
						{ number: 0, url: job.url },
						{ task, cwd, timeoutMs: agentTimeoutMs, logName },
						runners.claude,
						signal,
					),
			});
		} catch (err) {
			log.error(`repo job ${job.id} failed unexpectedly: ${describeError(err)}`);
		} finally {
			state.setCurrent(null);
			inFlight.delete(job.id);
			active = null;
		}
	}

	function senderAllowed(message: ChatMessage, command: GatedCommand): boolean {
		const sender = message.from.id;
		if (config.address.allowAnySender || (sender !== undefined && config.owner.senderIds.includes(sender))) {
			return true;
		}
		log.info(
			`message ${message.id} ${command} refused: sender ${message.from.name ?? "unknown"} (${sender ?? "no id"}) is not in owner.senderIds`,
		);
		return false;
	}

	function clearPendingEmoji(): void {
		pendingEmoji?.cancel();
		pendingEmoji = null;
	}

	async function startEmoji(chatId: string, name: string | undefined): Promise<void> {
		const slot = name === undefined ? undefined : resolveReactionSlot(name);
		if (slot === undefined) {
			await send(
				chatId,
				`Pick a reaction slot: ${REACTION_STATES.join(", ")}. For example: $emoji approved`,
			);
			return;
		}
		clearPendingEmoji();
		const since = clock().getTime();
		const messageIds = await send(chatId, `React to this message with the emoji for ${slot}.`);
		if (messageIds.length === 0) {
			log.warn(`$emoji ${slot}: the relay returned no message id for the prompt`);
			return;
		}
		clearPendingEmoji();
		const pending: PendingEmoji = { slot, chatId, messageIds, since, cancel: () => undefined };
		pending.cancel = schedule(EMOJI_WAIT_MS, async () => {
			if (pendingEmoji !== pending) return;
			pendingEmoji = null;
			log.info(`$emoji ${slot}: no custom reaction within ${EMOJI_WAIT_MINUTES} minutes`);
			await send(
				chatId,
				`No custom emoji arrived within ${EMOJI_WAIT_MINUTES} minutes, so nothing was saved for ${slot}.`,
			);
		});
		pendingEmoji = pending;
	}

	async function handleReaction(reaction: ChatReaction): Promise<void> {
		const pending = pendingEmoji;
		if (!pending) return;
		const id = capturedReactionId(reaction, {
			messageIds: pending.messageIds,
			since: pending.since,
			log,
		});
		if (id === undefined) return;
		clearPendingEmoji();
		const { slot, chatId } = pending;
		try {
			persistReaction(slot, id);
		} catch (err) {
			log.error(`$emoji ${slot}: could not save ${id}: ${describeError(err)}`);
			await send(chatId, `I couldn't save the emoji for ${slot}, so nothing changed.`);
			return;
		}
		reactionIds[slot] = id;
		log.info(`$emoji ${slot}: saved ${id}`);
		await send(chatId, `Saved :${id.split(";")[0]}: for ${slot}.`);
	}

	function quotedOptions(quote: string | undefined): BlockedOptions {
		const quoted = quote
			? parseTrigger(quote.replace(/^<blockquote\b[^>]*>|<\/blockquote>$/gi, ""), {
					ownerToken: config.owner.token,
					hosts: config.hosts,
				})
			: undefined;
		return quoted?.kind === "run"
			? { spice: quoted.spice, comment: quoted.comment, fun: quoted.fun, agent: quoted.agent }
			: { comment: false, fun: false };
	}

	function toJob(
		message: ChatMessage,
	): Job | { error: CrCode } | { help: HelpTopic } | { emoji: string | undefined } | null {
		const trigger = parseTrigger(message.text, {
			ownerToken: config.owner.token,
			hosts: config.hosts,
		});
		if (trigger.kind === "help") return { help: trigger.topic };
		if (trigger.kind === "error") return { error: trigger.code };
		if (trigger.kind === "emoji") {
			return senderAllowed(message, "$emoji") ? { emoji: trigger.slot } : { error: "CR-107" };
		}
		if (trigger.kind === "address") {
			if (!senderAllowed(message, "$address")) return { error: "CR-106" };
			return {
				kind: "address",
				messageId: message.id,
				chatId: message.chatId,
				url: trigger.url,
				number: trigger.number,
				host: trigger.host,
				noCi: trigger.noCi,
			};
		}
		if (trigger.kind === "run") {
			return {
				kind: "review",
				messageId: message.id,
				chatId: message.chatId,
				url: trigger.url,
				number: trigger.number,
				host: trigger.host,
				spice: trigger.spice,
				comment: trigger.comment,
				stacked: trigger.stacked,
				fun: trigger.fun,
				agent: trigger.agent,
			};
		}

		const blocked = state.get().blocked;
		const readiness = parseReadiness(message.text, {
			phrases: config.rereview.phrases,
			blockedMessages: Object.fromEntries(
				Object.values(blocked).map((entry) => [entry.messageId, entry.url]),
			),
			hosts: config.hosts,
		});
		if (readiness.kind === "ignore") {
			log.info(
				`message ${message.id} ignored: ${
					readiness.reason === "no-phrase"
						? "no owner token and no readiness phrase"
						: "readiness phrase but no PR link"
				}`,
			);
			return null;
		}
		const target = parsePrUrl(readiness.url, config.hosts);
		if (!target) return null;
		return {
			kind: "review",
			messageId: message.id,
			chatId: message.chatId,
			...target,
			...(blocked[prKey(target.url)]?.options ?? quotedOptions(readiness.quote)),
			stacked: false,
		};
	}

	async function handle(message: ChatMessage): Promise<void> {
		if (message.from.isBot) {
			log.info(`message ${message.id} ignored: bot message`);
			return;
		}
		if (state.get().handled[message.id]) return;

		const job = toJob(message);
		if (!job) return;
		if ("help" in job) {
			state.markHandled(message.id, "done", message.chatId);
			await attempt("reply", () =>
				provider.reply({
					chatId: message.chatId,
					text: helpText(
						botName,
						config.owner.token,
						config.rereview.phrases,
						config.reactions,
						job.help,
						config.address.allowAnySender,
					),
					html: true,
				}),
			);
			return;
		}
		if ("emoji" in job) {
			state.markHandled(message.id, "done", message.chatId);
			await startEmoji(message.chatId, job.emoji);
			return;
		}
		if ("error" in job) {
			state.markHandled(message.id, "failed", message.chatId);
			await move(message.chatId, message.id, "failure");
			reactionState.delete(message.id);
			await post(message.chatId, replyText(job.error, { owner }), "failure", false);
			return;
		}

		const key = prKey(job.url);
		if (inFlight.has(key)) {
			log.info(`message ${message.id} ignored: ${key} already has a job in flight`);
			state.markHandled(message.id, "done", message.chatId);
			return;
		}
		inFlight.add(key);
		state.markHandled(message.id, "pending", message.chatId);
		await move(message.chatId, message.id, "pending");
		tail = enqueue(() => runJob(job));
	}

	async function idle(): Promise<void> {
		let seen: Promise<void>;
		do {
			seen = tail;
			await seen;
		} while (seen !== tail);
	}

	function maintain(): void {
		state.pruneHandled(clock());
		pruneJobLogs(paths.jobsDir, clock());
	}

	return {
		handle,
		handleReaction,
		idle,
		maintain,
		async recover(seam) {
			maintain();
			const { current, handled } = state.get();
			if (
				current?.pid !== undefined &&
				current.pidStart !== undefined &&
				seam.isAlive(current.pid) &&
				seam.startTime(current.pid) === current.pidStart &&
				RUNNER_PROCESS.test(seam.listArgs(current.pid)) &&
				clock().getTime() - Date.parse(current.startedAt) < longestTimeoutMs
			) {
				await seam.killTree(current.pid);
			}
			state.setCurrent(null);

			const fixing = Object.entries(state.get().issues).filter(
				([, entry]) => entry.status === "fixing",
			);
			sweepCloneRoot(config.automation.cloneRoot, [], log);
			for (const [key, entry] of fixing) {
				state.setIssue(key, { status: "failed", firstSeen: entry.firstSeen });
				await notify(replyText("CR-205", { owner }));
			}

			const interrupted = Object.entries(handled).filter(
				([, entry]) => entry.status === "pending" || entry.status === "running",
			);
			removeLeftoverClones(
				config.address.cloneRoot,
				interrupted.map(([messageId]) => messageId),
				log,
			);
			for (const [messageId, entry] of interrupted) {
				const chatId = entry.chatId ?? defaultChatId;
				state.markHandled(messageId, "failed", chatId);
				await move(chatId, messageId, "failure", entry.status === "pending" ? "pending" : "inProgress");
				reactionState.delete(messageId);
				await post(chatId, replyText("CR-205", { owner }), "failure", false);
			}
		},
		enqueueRepo(job) {
			if (stopped || inFlight.has(job.id)) return false;
			inFlight.add(job.id);
			tail = enqueue(() => runRepoJob({ kind: "repo", ...job }));
			return true;
		},
		async stop() {
			stopped = true;
			clearPendingEmoji();
			active?.abort();
			await idle();
		},
	};
}
