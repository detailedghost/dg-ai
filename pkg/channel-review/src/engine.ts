import { join } from "node:path";
import { createChannel, describeError, escapeHtml } from "@dg/common";
import {
	type AddressWorkspace,
	cloneDirName,
	slug,
	errorCode,
	removeCloneDir,
	removeLeftoverClones,
} from "./address";
import { ensurePrivateDir } from "@dg/common/node";
import { type ChannelConfig, resolveReactionSlot } from "./config";
import { createNotifier } from "./automation/notify";
import { sweepCloneRoot } from "./automation/repo-job";
import { DEPS_RUNNING } from "./automation/types";
import { type CrCode, ownerName, replyText } from "./errors";
import { type FunEntry, decorateReply, funVerdictFor, pickFun } from "./fun";
import { EMOJI_WAIT_MINUTES, helpText } from "./help";
import { pruneJobLogs } from "./job-logs";
import type { ChannelReviewPaths } from "./paths";
import type { ChatMessage, ChatProvider, ChatReaction } from "./providers/types";
import { capturedReactionId, REACTION_STATES, type ReactionState, transition } from "./reactions";
import { resolveModel } from "./runners/model";
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
		task: Extract<RunTask, { task: "fix" | "deps" }>;
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
	model?: string;
};

const RUNNER_LABELS: Record<RunnerName, string> = {
	claude: "Claude",
	codex: "Codex",
	copilot: "Copilot",
	grok: "Grok",
};

function fallbackNotice(name: RunnerName): string {
	return `Claude is out of tokens, so I'm using ${RUNNER_LABELS[name]} for this review.`;
}

type ReviewRunner = { runner: Runner; model?: string };

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

const MAX_QUEUED = 64;

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
	const jobs = createChannel<() => Promise<void>>(MAX_QUEUED);
	const controllers = new Set<AbortController>();
	const idleWaiters: (() => void)[] = [];
	let outstanding = 0;
	let stopped = false;
	let pendingEmoji: PendingEmoji | null = null;

	function submit(task: () => Promise<void>): void {
		outstanding += 1;
		const finish = (): void => {
			outstanding -= 1;
			if (outstanding === 0) for (const resolve of idleWaiters.splice(0)) resolve();
		};
		jobs
			.send(async () => {
				try {
					await task();
				} catch (err) {
					log.error(`job failed unexpectedly: ${describeError(err)}`);
				} finally {
					finish();
				}
			})
			.catch((err: unknown) => {
				log.error(`job was not queued: ${describeError(err)}`);
				finish();
			});
	}

	async function work(): Promise<void> {
		for await (const task of jobs) await task();
	}

	const reviewDir = (messageId: string): string => join(paths.workDir, slug(messageId));

	const workers = Array.from({ length: config.runner.concurrency }, work);

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
				model: job.model,
			};
			state.markBlocked(target.url, job.messageId, options, job.chatId);
		} else if (state.get().blocked[key] && (typeof outcome === "string" || outcome.code === "CR-302")) {
			state.clearBlocked(target.url);
		}
	}

	async function verdictPosted(
		target: Target,
		host: PrHost,
		since: Date,
	): Promise<boolean> {
		try {
			return (await verdict.read({ url: target.url, host, since })) !== "none";
		} catch {
			return false;
		}
	}

	async function execute(
		job: Pick<JobBase, "messageId" | "chatId"> & { host?: PrHost },
		target: Target,
		run: {
			task: RunTask;
			cwd: string;
			timeoutMs: number;
			logName: string;
			model?: string;
		},
		runner: Runner,
		signal: AbortSignal,
	): Promise<CrCode | null> {
		if (signal.aborted) return "CR-205";
		const { model, source } = resolveModel(runner.name, run.model, config);
		state.setRunning(job.messageId, {
			messageId: job.messageId,
			chatId: job.chatId,
			url: target.url,
			number: target.number,
			startedAt: clock().toISOString(),
			...(run.task.task === "thrash"
				? {
					execution: {
						origin: run.task.origin ?? "manual",
						backend: runner.name,
						model,
						modelSource: source,
					} as const,
				}
				: {}),
		});
		if (run.task.task === "thrash") {
			const modelNote = model
				? `${source} model: ${model}`
				: "CLI default; model unresolved";
			log.info(
				`Review execution: Automatic (daemon); orchestrator: ${runner.name} (${modelNote}); reviewer models are recorded per chunk.`,
			);
		}
		let result: Awaited<ReturnType<Runner["run"]>>;
		const ranAt = clock();
		try {
			result = await runner.run({
				...run.task,
				model: run.model,
				cwd: run.cwd,
				timeoutMs: run.timeoutMs,
				logPath: join(paths.jobsDir, `${run.logName}.log`),
				signal,
				onSpawn: (pid) => {
					const current = state.get().running[job.messageId];
					if (current) state.setRunning(job.messageId, { ...current, pid, pidStart: startTime(pid) });
				},
			});
		} catch (err) {
			log.error(`runner ${runner.name} threw: ${describeError(err)}`);
			return "CR-203";
		}
		if (result.aborted) return "CR-205";
		if (result.timedOut) return "CR-204";
		if (
			result.code === "CR-207" &&
			result.status === 0 &&
			run.task.task === "thrash" &&
			job.host !== undefined &&
			(await verdictPosted(target, job.host, ranAt))
		)
			return null;
		if (result.code === "CR-207") {
			log.warn(
				`runner ${runner.name} reached its usage limit: ${run.task.task}`,
			);
			if (run.task.task !== "thrash")
				await attempt("usage-limit owner notification", () =>
					provider.dm({
						text: `${replyText("CR-207", { agent: runner.name })}\nTask: ${run.task.task}\n${target.url}`,
					}),
				);
		}
		if (result.code) return result.code;
		return result.status === 0 ? null : "CR-203";
	}

	async function review(
		job: ReviewJob,
		target: Target,
		logName: string,
		selection: ReviewRunner,
		signal: AbortSignal,
	): Promise<Outcome> {
		let startedAt = clock();
		const deadline = startedAt.getTime() + timeoutMs;
		let attemptLogName = logName;
		const run = () => {
			const remainingMs = deadline - clock().getTime();
			if (remainingMs <= 0) return Promise.resolve("CR-204" as const);
			return execute(
				job,
				target,
				{
					task: {
						task: "thrash",
						origin: "daemon",
						url: target.url,
						spice: job.spice,
						comment: job.comment,
					},
					cwd: reviewDir(job.messageId),
					timeoutMs: remainingMs,
					logName: attemptLogName,
					model: selection.model,
				},
				selection.runner,
				signal,
			);
		};
		let failed = await run();
		if (
			failed === "CR-207" &&
			selection.runner.name === "claude" &&
			config.runner.fallback !== null
		) {
			if (signal.aborted) return { code: "CR-205" };
			const fallback = runners[config.runner.fallback];
			let available = false;
			try {
				const probed = await fallback.probe({ cwd: paths.workDir });
				available = probed.ok;
				if (!probed.ok)
					log.warn(`fallback ${fallback.name} is unavailable: ${probed.code}`);
			} catch (error) {
				log.warn(`fallback probe failed: ${describeError(error)}`);
			}
			if (signal.aborted) return { code: "CR-205" };
			if (clock().getTime() >= deadline) return { code: "CR-204" };
			if (available) {
				await attempt("fallback reply", () =>
					provider.reply({
						chatId: job.chatId,
						html: true,
						text: `<blockquote itemscope="" itemtype="http://schema.skype.com/Reply" itemid="${escapeHtml(job.messageId)}"><p>${escapeHtml(job.url)}</p></blockquote><p>${fallbackNotice(fallback.name)}</p>`,
					}),
				);
				selection.runner = fallback;
				selection.model = undefined;
				attemptLogName = `${logName}-fallback-${fallback.name}`;
				startedAt = clock();
				failed = await run();
			}
		}
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
		const runnerProbe = await runner.probe({ cwd: paths.workDir });
		if (!runnerProbe.ok) return runnerProbe.code;
		const verdictProbe = await verdict.probe({ host: job.host, url: job.url });
		return verdictProbe.ok ? null : verdictProbe.code;
	}

	async function reviewSingle(
		job: ReviewJob,
		selection: ReviewRunner,
		signal: AbortSignal,
	): Promise<void> {
		const target = { number: job.number, url: job.url };
		const outcome = await review(job, target, job.messageId, selection, signal);
		settleBlocked(job, target, outcome);
		if (typeof outcome !== "string")
			return fail(job, outcome.code, selection.runner.name);

		const label = VERDICT_LABELS[outcome];
		log.info(`message ${job.messageId} done: ${outcome} ${job.url}`);
		state.markHandled(job.messageId, "done", job.chatId);
		await move(job.chatId, job.messageId, outcomeOf(outcome));
		if (job.fun) {
			await post(job.chatId, `${label.emoji} ${label.word} #${job.number} ${job.url}`, outcomeOf(outcome), true);
		}
	}

	async function reviewStack(
		job: ReviewJob,
		selection: ReviewRunner,
		signal: AbortSignal,
	): Promise<void> {
		let descendants: Target[];
		try {
			descendants = await stack.descendants({ url: job.url, host: job.host });
		} catch (err) {
			const code = err instanceof VerdictError ? err.code : "CR-304";
			if (!(err instanceof VerdictError)) {
				log.error(`stack read threw: ${describeError(err)}`);
			}
			return fail(job, code, selection.runner.name);
		}

		const rows: StackRow[] = [];
		for (const target of [{ number: job.number, url: job.url }, ...descendants]) {
			const outcome = signal.aborted
				? ({ code: "CR-205" } as const)
				: await review(
						job,
						target,
						`${job.messageId}-${target.number}`,
						selection,
						signal,
					);
			if (typeof outcome !== "string" && outcome.code === "CR-205") {
				return fail(job, "CR-205", selection.runner.name);
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
		controllers.add(controller);
		const runner =
			runners[
				job.kind === "address" ? "claude" : (job.agent ?? config.runner.default)
			];
		const selection: ReviewRunner = {
			runner,
			model: job.kind === "review" ? job.model : undefined,
		};
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
			else if (job.stacked)
				await reviewStack(job, selection, controller.signal);
			else await reviewSingle(job, selection, controller.signal);
		} catch (err) {
			log.error(
				`job ${job.messageId} failed unexpectedly: ${describeError(err)}`,
			);
			await fail(job, "CR-203", selection.runner.name);
		} finally {
			state.setRunning(job.messageId, null);
			reactionState.delete(job.messageId);
			inFlight.delete(prKey(job.url));
			controllers.delete(controller);
			removeCloneDir(paths.workDir, reviewDir(job.messageId), log);
		}
	}

	async function runRepoJob(job: RepoJob): Promise<void> {
		if (stopped) {
			inFlight.delete(job.id);
			return;
		}
		const controller = new AbortController();
		controllers.add(controller);
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
			state.setRunning(job.id, null);
			inFlight.delete(job.id);
			controllers.delete(controller);
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
			? {
					spice: quoted.spice,
					comment: quoted.comment,
					fun: quoted.fun,
					agent: quoted.agent,
					model: quoted.model,
				}
			: { comment: false, fun: false };
	}

	function toJob(
		message: ChatMessage,
	):
		| Job
		| { error: CrCode }
		| { help: HelpTopic }
		| { emoji: string | undefined }
		| null {
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
				model: trigger.model,
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
		if (stopped || state.get().handled[message.id]) return;

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
		if (inFlight.size >= MAX_QUEUED) {
			log.warn(`message ${message.id} refused: ${MAX_QUEUED} jobs are already queued`);
			state.markHandled(message.id, "failed", message.chatId);
			await move(message.chatId, message.id, "failure");
			reactionState.delete(message.id);
			await post(message.chatId, replyText("CR-109", { owner }), "failure", false);
			return;
		}
		inFlight.add(key);
		state.markHandled(message.id, "pending", message.chatId);
		await move(message.chatId, message.id, "pending");
		log.info(`message ${message.id} queued: ${job.url}`);
		submit(() => runJob(job));
	}

	function idle(): Promise<void> {
		if (outstanding === 0) return Promise.resolve();
		return new Promise((resolve) => idleWaiters.push(resolve));
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
			const { current, running, handled } = state.get();
			const orphans = new Map(Object.entries(running));
			if (current && !orphans.has(current.messageId)) orphans.set(current.messageId, current);
			for (const orphan of orphans.values()) {
				if (
					orphan.pid !== undefined &&
					orphan.pidStart !== undefined &&
					seam.isAlive(orphan.pid) &&
					seam.startTime(orphan.pid) === orphan.pidStart &&
					RUNNER_PROCESS.test(seam.listArgs(orphan.pid)) &&
					clock().getTime() - Date.parse(orphan.startedAt) < longestTimeoutMs
				) {
					await seam.killTree(orphan.pid);
				}
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
			const upgrading = Object.entries(state.get().deps.lastRun).filter(
				([, run]) => run.result === DEPS_RUNNING,
			);
			for (const [repo, run] of upgrading) {
				state.recordDepsRun(repo, { windowStart: run.windowStart, result: "failed" });
				await notify(`Deps upgrade for ${repo} was interrupted. ${replyText("CR-205", { owner })}`);
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
			if (stopped || inFlight.size >= MAX_QUEUED || inFlight.has(job.id)) return false;
			inFlight.add(job.id);
			submit(() => runRepoJob({ kind: "repo", ...job }));
			return true;
		},
		async stop() {
			stopped = true;
			clearPendingEmoji();
			for (const controller of controllers) controller.abort();
			jobs.close();
			await Promise.all(workers);
		},
	};
}
