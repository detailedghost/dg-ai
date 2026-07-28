import {
	MAILBOX_REASON_CODES,
	type MailboxReasonCode,
} from "@dg/common";
import type {
	MailboxProviderActionDelta,
	MailboxProviderDispatchRequest,
	MailboxProviderObserveRequest,
	MailboxProviderPreflightRequest,
} from "../providers";
import {
	MailboxExecutionJournalError,
	type CanonicalMailboxExecutionRevision,
	type MailboxExecutionActionResult,
	type MailboxExecutionAuthorityScope,
	type MailboxExecutionCommand,
	type MailboxExecutionCoordinator,
	type MailboxExecutionInboxObservation,
	type MailboxExecutionJournal,
	type MailboxExecutionJournalSnapshot,
	type MailboxExecutionLease,
	type MailboxExecutionObservation,
	type MailboxExecutionProvider,
	type MailboxExecutionResult,
	type MailboxExecutionVerification,
} from "./contracts";
import {
	buildMailboxExecutionAuthorityScope,
	buildMailboxExecutionGraph,
	validateCanonicalMailboxExecutionRevision,
} from "./graph";

const PLAN_ALIAS = /^plan_[a-f0-9]{32}$/;
const REVISION_ALIAS = /^rev_[a-f0-9]{32}$/;
const ACCOUNT_ALIAS = /^acct_[a-f0-9]{32}$/;
const DEFAULT_PHASE_TIMEOUT_MS = 15_000;
const MIN_PHASE_TIMEOUT_MS = 10;
const MAX_PHASE_TIMEOUT_MS = 120_000;

type PlainRecord = Record<string, unknown>;

type MailboxExecutionCoordinatorDeps = Readonly<{
	loadRevision(planAlias: string, revisionAlias: string): Promise<unknown>;
	loadBinding(
		planAlias: string,
		revisionAlias: string,
	): Promise<Readonly<{
		scope: Readonly<Record<string, unknown>>;
		bindings: Readonly<Record<string, unknown>>;
	}>>;
	resolveProvider(
		scope: Readonly<Record<string, unknown>>,
	): Promise<MailboxExecutionProvider>;
	computeFingerprint(
		input: Readonly<Record<string, unknown>>,
	): Promise<Readonly<{
		schemaVersion: 1;
		algorithm: "sha256";
		digest: string;
	}>>;
	journal: MailboxExecutionJournal;
	now(): string;
	generateDebrief(input: Readonly<Record<string, unknown>>): Promise<unknown>;
	transitionRevision(
		planAlias: string,
		revisionAlias: string,
		expected: "approved" | "in_flight",
		next: "in_flight" | "completed" | "canceled",
	): Promise<void>;
	phaseTimeoutMs?: number;
}>;

type ActiveRun = Readonly<{
	controller: AbortController;
	promise: Promise<MailboxExecutionResult>;
}>;

class PhaseError extends Error {
	override readonly name = "PhaseError";

	constructor(readonly code: "provider_canceled" | "provider_timeout") {
		super(`Mailbox provider phase stopped: ${code}`);
	}
}

function plain(value: unknown): PlainRecord | undefined {
	return value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
		? value as PlainRecord
		: undefined;
}

function exact(
	value: unknown,
	required: readonly string[],
	optional: readonly string[] = [],
): PlainRecord | undefined {
	const input = plain(value);
	if (input === undefined) return undefined;
	const allowed = new Set([...required, ...optional]);
	return required.every((field) => Object.hasOwn(input, field)) &&
		Object.keys(input).every((field) => allowed.has(field))
		? input
		: undefined;
}

function stringArray(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const strings: string[] = [];
	for (const candidate of value) {
		if (typeof candidate !== "string") return undefined;
		strings.push(candidate);
	}
	return strings;
}

function reason(value: unknown, fallback: MailboxReasonCode): MailboxReasonCode {
	const input = plain(value);
	const candidate =
		input?.reasonCode ??
		input?.code ??
		(value instanceof Error &&
		"code" in value &&
		typeof value.code === "string"
			? value.code
			: undefined);
	if (candidate === "provider_canceled") return "canceled";
	if (candidate === "provider_timeout") return "provider_timeout";
	return typeof candidate === "string" &&
		MAILBOX_REASON_CODES.includes(
			candidate as (typeof MAILBOX_REASON_CODES)[number],
		)
		? candidate as MailboxReasonCode
		: fallback;
}

function failed(
	reasonCode: MailboxReasonCode = "internal_failure",
): MailboxExecutionResult {
	return Object.freeze({ status: "failed", reasonCode, resumable: false });
}

function paused(
	reasonCode: MailboxReasonCode,
	resumable = true,
): MailboxExecutionResult {
	return Object.freeze({ status: "paused", reasonCode, resumable });
}

function validCommand(value: MailboxExecutionCommand): boolean {
	return (
		value !== null &&
		typeof value === "object" &&
		Object.getPrototypeOf(value) === Object.prototype &&
		Object.keys(value).length === 2 &&
		PLAN_ALIAS.test(value.planAlias) &&
		REVISION_ALIAS.test(value.revisionAlias)
	);
}

function key(command: MailboxExecutionCommand): string {
	return `${command.planAlias}:${command.revisionAlias}`;
}

function terminalResult(
	snapshot: MailboxExecutionJournalSnapshot,
): MailboxExecutionResult | undefined {
	if (snapshot.terminalStatus === undefined) return undefined;
	return Object.freeze({
		status: snapshot.terminalStatus,
		...(snapshot.terminalStatus === "completed"
			? {}
			: {
					reasonCode:
						snapshot.terminalReasonCode ??
						(snapshot.terminalStatus === "canceled"
							? "canceled"
							: "internal_failure"),
				}),
		resumable: false,
		debriefAvailable: snapshot.debriefStatus === "available",
	});
}

function scope(
	value: unknown,
	revisionAlias: string,
): Readonly<{
	providerId: string;
	surface: string;
	accountAlias: string;
	runAlias: string;
	revisionAlias: string;
}> | undefined {
	const input = plain(value);
	if (
		input === undefined ||
		typeof input.providerId !== "string" ||
		typeof input.surface !== "string" ||
		typeof input.accountAlias !== "string" ||
		!ACCOUNT_ALIAS.test(input.accountAlias) ||
		typeof input.runAlias !== "string" ||
		input.revisionAlias !== revisionAlias
	) {
		return undefined;
	}
	return Object.freeze({
		providerId: input.providerId,
		surface: input.surface,
		accountAlias: input.accountAlias,
		runAlias: input.runAlias,
		revisionAlias,
	});
}

function actionAliases(
	action: CanonicalMailboxExecutionRevision["actions"][number],
): readonly string[] {
	const fields = new Set([
		"messageAlias",
		"folderAlias",
		"replacementFolderAlias",
		"labelAlias",
		"replacementLabelAlias",
		"filterAlias",
		"replacementFilterAlias",
	]);
	return Object.freeze(
		Object.entries(action).flatMap(([field, value]) =>
			fields.has(field) && typeof value === "string" ? [value] : [],
		),
	);
}

function rawTargets(
	actions: readonly CanonicalMailboxExecutionRevision["actions"][number][],
	bindings: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string>> {
	const targets: Record<string, string> = {};
	for (const alias of new Set(actions.flatMap(actionAliases))) {
		const raw = bindings[alias];
		if (typeof raw === "string") targets[alias] = raw;
	}
	return Object.freeze(targets);
}

function preflightRequest(
	snapshot: MailboxExecutionJournalSnapshot,
	providerScope: ReturnType<typeof scope> & {},
	bindings: Readonly<Record<string, unknown>>,
): MailboxProviderPreflightRequest {
	return Object.freeze({
		...providerScope,
		actions: snapshot.revision.actions,
		rawTargets: rawTargets(snapshot.revision.actions, bindings),
	});
}

function actionRequest(
	snapshot: MailboxExecutionJournalSnapshot,
	providerScope: ReturnType<typeof scope> & {},
	bindings: Readonly<Record<string, unknown>>,
	index: number,
): MailboxProviderDispatchRequest {
	const action = snapshot.actions[index]?.action;
	if (action === undefined) throw new Error("Missing execution action");
	return Object.freeze({
		...providerScope,
		action,
		rawTargets: rawTargets([action], bindings),
	});
}

function projectPreflight(
	value: unknown,
	snapshot: MailboxExecutionJournalSnapshot,
	providerScope: ReturnType<typeof scope> & {},
): MailboxExecutionResult | undefined {
	const input = plain(value);
	if (input?.status === "blocked") {
		const blocked = exact(value, ["status", "reasonCode"], ["prompt"]);
		if (
			blocked === undefined ||
			!MAILBOX_REASON_CODES.includes(
				blocked.reasonCode as (typeof MAILBOX_REASON_CODES)[number],
			) ||
			(blocked.prompt !== undefined &&
				![
					"login",
					"mfa",
					"captcha",
					"consent",
					"conditional_access",
				].includes(String(blocked.prompt)))
		) {
			return paused("provider_refused");
		}
		return paused(blocked.reasonCode as MailboxReasonCode);
	}
	const ready = exact(value, [
		"status",
		"providerId",
		"surface",
		"accountAlias",
		"locale",
		"layout",
		"capabilities",
		"targets",
	]);
	if (ready === undefined || ready.status !== "ready") {
		return paused("provider_refused");
	}
	if (ready.providerId !== providerScope.providerId) {
		return paused("provider_refused");
	}
	if (ready.surface !== providerScope.surface) {
		return paused("layout_mismatch");
	}
	if (ready.accountAlias !== providerScope.accountAlias) {
		return paused("wrong_account");
	}
	if (ready.locale !== "en-US") return paused("unsupported_locale");
	if (ready.layout !== "supported") return paused("layout_mismatch");
	if (ready.targets !== "available") return paused("not_found");
	const capabilities = stringArray(ready.capabilities);
	if (
		capabilities === undefined ||
		snapshot.actions.some(
			(entry) => !capabilities.includes(entry.action.type),
		)
	) {
		return paused("provider_refused");
	}
	return undefined;
}

function projectDispatch(value: unknown): boolean {
	const input = exact(value, ["status"]);
	return input?.status === "dispatched";
}

function projectObservation(
	value: unknown,
): MailboxExecutionObservation | MailboxReasonCode {
	const input = plain(value);
	if (input?.status === "observed") {
		const observed = exact(value, ["status", "observedAt"]);
		if (
			observed !== undefined &&
			typeof observed.observedAt === "string"
		) {
			return Object.freeze({
				status: "observed",
				observedAt: observed.observedAt,
			});
		}
	}
	const ambiguous = exact(value, ["status", "reasonCode"]);
	return ambiguous?.status === "ambiguous" &&
		typeof ambiguous.reasonCode === "string" &&
		MAILBOX_REASON_CODES.includes(
			ambiguous.reasonCode as (typeof MAILBOX_REASON_CODES)[number],
		)
		? ambiguous.reasonCode as MailboxReasonCode
		: "provider_refused";
}

function projectVerification(
	value: unknown,
): Readonly<{
	verifiedAt: string;
	delta: MailboxProviderActionDelta;
}> | MailboxReasonCode {
	const input = plain(value);
	if (input?.status === "verified") {
		const verified = exact(value, ["status", "verifiedAt", "delta"]);
		const delta =
			verified === undefined ? undefined : exact(verified.delta, [
				"schemaVersion",
				"scope",
				"actionAlias",
				"changedAliases",
			]);
		if (
			verified !== undefined &&
			typeof verified.verifiedAt === "string" &&
			delta !== undefined &&
			delta.schemaVersion === 1 &&
			delta.scope === "entire_fingerprint" &&
			typeof delta.actionAlias === "string" &&
			Array.isArray(delta.changedAliases) &&
			new Set(delta.changedAliases).size === delta.changedAliases.length &&
			delta.changedAliases.every((alias) => typeof alias === "string")
		) {
			return Object.freeze({
				verifiedAt: verified.verifiedAt,
				delta: Object.freeze({
					schemaVersion: 1,
					scope: "entire_fingerprint",
					actionAlias: delta.actionAlias,
					changedAliases: Object.freeze([...delta.changedAliases]),
				}),
			});
		}
	}
	const stopped = exact(value, ["status"], ["reasonCode"]);
	if (
		stopped !== undefined &&
		stopped.status === "timeout"
	) {
		return "provider_timeout";
	}
	if (
		stopped !== undefined &&
		["mismatch", "ambiguous"].includes(String(stopped.status)) &&
		typeof stopped.reasonCode === "string" &&
		MAILBOX_REASON_CODES.includes(
			stopped.reasonCode as (typeof MAILBOX_REASON_CODES)[number],
		)
	) {
		return stopped.reasonCode as MailboxReasonCode;
	}
	return "provider_refused";
}

export function mailboxExecutionChangedAliases(
	action: CanonicalMailboxExecutionRevision["actions"][number],
): readonly string[] {
	const aliases = (() => {
		switch (action.type) {
			case "archive":
			case "mark_read":
				return [action.messageAlias];
			case "move_to_folder":
				return [action.messageAlias, action.folderAlias];
			case "apply_label":
			case "apply_category":
				return [action.messageAlias, action.labelAlias];
			case "create_folder":
				return [];
			case "rename_folder":
				return [action.folderAlias];
			case "create_label":
			case "create_category":
				return [];
			case "rename_label":
			case "rename_category":
				return [action.labelAlias];
			case "create_filter":
				return [];
			case "deactivate_filter":
				return [action.filterAlias];
			case "change_filter":
				return [action.filterAlias];
		}
	})();
	return Object.freeze([...aliases].sort());
}

function exactActionDelta(
	value: Readonly<{
		verifiedAt: string;
		delta: MailboxProviderActionDelta;
	}>,
	action: CanonicalMailboxExecutionRevision["actions"][number],
): boolean {
	return (
		value.delta.actionAlias === action.actionAlias &&
			JSON.stringify([...value.delta.changedAliases].sort()) ===
			JSON.stringify(mailboxExecutionChangedAliases(action))
	);
}

function linkedVerification(
	value: Readonly<{
		verifiedAt: string;
		delta: MailboxProviderActionDelta;
	}>,
	before: MailboxExecutionJournalSnapshot["authorityFingerprint"],
	after: MailboxExecutionJournalSnapshot["authorityFingerprint"],
	beforeScope: MailboxExecutionAuthorityScope,
	afterScope: MailboxExecutionAuthorityScope,
): MailboxExecutionVerification {
	return Object.freeze({
		status: "verified",
		verifiedAt: value.verifiedAt,
		delta: Object.freeze({
			...value.delta,
			changedAliases: Object.freeze([...value.delta.changedAliases].sort()),
			beforeFingerprint: Object.freeze({ ...before }),
			afterFingerprint: Object.freeze({ ...after }),
			beforeScope,
			afterScope,
		}),
	});
}

function remainingAuthorityScope(
	snapshot: MailboxExecutionJournalSnapshot,
	afterIndex?: number,
): MailboxExecutionAuthorityScope {
	const position =
		afterIndex === undefined
			? undefined
			: snapshot.order.indexOf(afterIndex);
	if (position === -1) {
		throw new MailboxExecutionJournalError("invalid_snapshot");
	}
	const offset = position === undefined ? 0 : position + 1;
	return buildMailboxExecutionAuthorityScope(
		snapshot.order.slice(offset).map((index) => {
			const action = snapshot.actions[index]?.action;
			if (action === undefined) {
				throw new MailboxExecutionJournalError("invalid_snapshot");
			}
			return action;
		}),
	);
}

function projectInbox(
	value: unknown,
): MailboxExecutionInboxObservation | undefined {
	const observed = exact(value, ["status", "count", "observedAt"]);
	return observed?.status === "observed" &&
		typeof observed.count === "number" &&
		Number.isSafeInteger(observed.count) &&
		observed.count >= 0 &&
		typeof observed.observedAt === "string"
		? Object.freeze({
				status: "observed",
				count: observed.count,
				observedAt: observed.observedAt,
			})
		: undefined;
}

function result(
	snapshot: MailboxExecutionJournalSnapshot,
	index: number,
	status: MailboxExecutionActionResult["status"],
	reasonCode?: MailboxReasonCode,
): MailboxExecutionActionResult {
	const action = snapshot.actions[index]?.action;
	if (action === undefined) throw new Error("Missing execution action");
	return Object.freeze({
		schemaVersion: 1,
		index,
		action,
		status,
		...(reasonCode === undefined ? {} : { reasonCode }),
		affectedCount: status === "completed" ? 1 : 0,
	});
}

function debriefInput(
	snapshot: MailboxExecutionJournalSnapshot,
): Readonly<Record<string, unknown>> {
	return Object.freeze({
		schemaVersion: 1,
		planAlias: snapshot.planAlias,
		revisionAlias: snapshot.revisionAlias,
		terminalStatus: snapshot.terminalStatus,
		results: Object.freeze(
			snapshot.actions.flatMap((entry) =>
				entry.result === undefined ? [] : [entry.result],
			),
		),
		...(snapshot.finalInboxObservation === undefined
			? {}
			: { finalInboxObservation: snapshot.finalInboxObservation }),
	});
}

async function bounded<T>(
	runSignal: AbortSignal,
	timeoutMs: number,
	operation: (options: {
		signal: AbortSignal;
		timeoutMs: number;
	}) => Promise<T>,
	ignoreRunCancel = false,
): Promise<T> {
	const controller = new AbortController();
	let stopCode: PhaseError["code"] | undefined;
	const onAbort = (): void => {
		stopCode = "provider_canceled";
		controller.abort();
	};
	if (!ignoreRunCancel) {
		if (runSignal.aborted) throw new PhaseError("provider_canceled");
		runSignal.addEventListener("abort", onAbort, { once: true });
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			stopCode = "provider_timeout";
			controller.abort();
			reject(new PhaseError("provider_timeout"));
		}, timeoutMs);
	});
	const canceled = new Promise<never>((_, reject) => {
		controller.signal.addEventListener(
			"abort",
			() =>
				reject(
					new PhaseError(stopCode ?? "provider_canceled"),
				),
			{ once: true },
		);
	});
	try {
		return await Promise.race([
			operation({ signal: controller.signal, timeoutMs }),
			timeout,
			canceled,
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		runSignal.removeEventListener("abort", onAbort);
	}
}

export function createMailboxExecutionCoordinator(
	deps: MailboxExecutionCoordinatorDeps,
): MailboxExecutionCoordinator {
	const timeoutMs = deps.phaseTimeoutMs ?? DEFAULT_PHASE_TIMEOUT_MS;
	if (
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs < MIN_PHASE_TIMEOUT_MS ||
		timeoutMs > MAX_PHASE_TIMEOUT_MS
	) {
		throw new Error("Invalid mailbox execution phase timeout");
	}
	const active = new Map<string, ActiveRun>();
	let ownerCounter = 0;

	const transition = async (
		command: MailboxExecutionCommand,
		lease: MailboxExecutionLease,
		snapshot: MailboxExecutionJournalSnapshot,
		next: "in_flight" | "completed" | "canceled",
	): Promise<MailboxExecutionJournalSnapshot> => {
		if (
			snapshot.lifecycleState !== "approved" &&
			snapshot.lifecycleState !== "in_flight"
		) {
			return snapshot;
		}
		const expected = snapshot.lifecycleState;
		await deps.journal.prepareLifecycle(command, lease, expected, next);
		await deps.journal.heartbeat(command, lease);
		await deps.transitionRevision(
			command.planAlias,
			command.revisionAlias,
			expected,
			next,
		);
		return deps.journal.commitLifecycle(
			command,
			lease,
			expected,
			next,
		);
	};

	const reconcile = async (
		command: MailboxExecutionCommand,
		lease: MailboxExecutionLease,
		snapshot: MailboxExecutionJournalSnapshot,
		external: CanonicalMailboxExecutionRevision["state"],
	): Promise<MailboxExecutionJournalSnapshot> => {
		const intent = snapshot.lifecycleIntent;
		if (intent === undefined) {
			if (snapshot.lifecycleState !== external) {
				throw new MailboxExecutionJournalError("invalid_snapshot");
			}
			return snapshot;
		}
		if (
			intent.terminalStatus !== undefined &&
			snapshot.terminalStatus === undefined
		) {
			snapshot = await deps.journal.finish(
				command,
				lease,
				intent.terminalStatus,
				intent.terminalReasonCode,
			);
		}
		if (external === intent.expected) {
			await deps.journal.heartbeat(command, lease);
			await deps.transitionRevision(
				command.planAlias,
				command.revisionAlias,
				intent.expected,
				intent.next,
			);
		} else if (external !== intent.next) {
			throw new MailboxExecutionJournalError("invalid_snapshot");
		}
		return deps.journal.commitLifecycle(
			command,
			lease,
			intent.expected,
			intent.next,
		);
	};

	const generateDebrief = async (
		command: MailboxExecutionCommand,
		lease: MailboxExecutionLease,
		snapshot: MailboxExecutionJournalSnapshot,
	): Promise<MailboxExecutionJournalSnapshot> => {
		try {
			const generated = await deps.generateDebrief(
				debriefInput(snapshot),
			);
			const durable = exact(generated, ["status"], [
				"filename",
				"content",
				"downloadId",
			]);
			if (durable?.status === "download_pending") {
				return deps.journal.setDebriefStatus(
					command,
					lease,
					"pending",
				);
			}
			if (durable?.status !== "downloaded") {
				throw new Error("Mailbox debrief download failed safely");
			}
			return await deps.journal.setDebriefStatus(
				command,
				lease,
				"available",
			);
		} catch {
			return deps.journal.setDebriefStatus(command, lease, "failed");
		}
	};

	const checkPreflight = async (
		snapshot: MailboxExecutionJournalSnapshot,
		provider: MailboxExecutionProvider,
		providerScope: ReturnType<typeof scope> & {},
		bindings: Readonly<Record<string, unknown>>,
		runSignal: AbortSignal,
	): Promise<MailboxExecutionResult | undefined> => {
		const preflight = await bounded(
			runSignal,
			timeoutMs,
			(options) =>
				provider.preflight(
					preflightRequest(snapshot, providerScope, bindings),
					options,
				),
		);
		return projectPreflight(
			preflight,
			snapshot,
			providerScope,
		);
	};

	const currentFingerprint = async (
		snapshot: MailboxExecutionJournalSnapshot,
		providerScope: ReturnType<typeof scope> & {},
		bindings: Readonly<Record<string, unknown>>,
		authorityScope = snapshot.authorityScope,
	): Promise<MailboxExecutionJournalSnapshot["authorityFingerprint"]> => {
		const fingerprint = await deps.computeFingerprint({
			schemaVersion: 1,
			revision: snapshot.revision,
			scope: providerScope,
			bindings,
			authorityScope,
		});
		if (
			fingerprint.schemaVersion !== 1 ||
			fingerprint.algorithm !== "sha256" ||
			!/^[a-f0-9]{64}$/.test(fingerprint.digest)
		) {
			throw new Error("Invalid mailbox execution fingerprint");
		}
		return Object.freeze(fingerprint);
	};

	const checkAuthority = async (
		snapshot: MailboxExecutionJournalSnapshot,
		provider: MailboxExecutionProvider,
		providerScope: ReturnType<typeof scope> & {},
		bindings: Readonly<Record<string, unknown>>,
		runSignal: AbortSignal,
	): Promise<MailboxExecutionResult | undefined> => {
		const preflight = await checkPreflight(
			snapshot,
			provider,
			providerScope,
			bindings,
			runSignal,
		);
		if (preflight !== undefined) return preflight;
		const fingerprint = await currentFingerprint(
			snapshot,
			providerScope,
			bindings,
		);
		return fingerprint.digest !== snapshot.authorityFingerprint.digest
			? paused("stale_binding", false)
			: undefined;
	};

	const settle = async (
		command: MailboxExecutionCommand,
		lease: MailboxExecutionLease,
		snapshot: MailboxExecutionJournalSnapshot,
		status: "completed" | "failed" | "canceled",
		reasonCode?: MailboxReasonCode,
	): Promise<MailboxExecutionResult> => {
		const target = status === "completed" ? "completed" : "canceled";
		if (
			snapshot.lifecycleState !== "approved" &&
			snapshot.lifecycleState !== "in_flight"
		) {
			throw new MailboxExecutionJournalError("invalid_snapshot");
		}
		const expected = snapshot.lifecycleState;
		snapshot = await deps.journal.prepareLifecycle(
			command,
			lease,
			expected,
			target,
			{ status, ...(reasonCode === undefined ? {} : { reasonCode }) },
		);
		snapshot = await deps.journal.finish(
			command,
			lease,
			status,
			reasonCode,
		);
		await deps.journal.heartbeat(command, lease);
		await deps.transitionRevision(
			command.planAlias,
			command.revisionAlias,
			expected,
			target,
		);
		snapshot = await deps.journal.commitLifecycle(
			command,
			lease,
			expected,
			target,
		);
		snapshot = await generateDebrief(command, lease, snapshot);
		return terminalResult(snapshot) ?? failed();
	};

	const prepareFailure = async (
		command: MailboxExecutionCommand,
		lease: MailboxExecutionLease,
		snapshot: MailboxExecutionJournalSnapshot,
		reasonCode: MailboxReasonCode,
		index?: number,
	): Promise<MailboxExecutionJournalSnapshot> => {
		const state =
			index === undefined ? undefined : snapshot.actions[index]?.state;
		if (index !== undefined && state === "dispatched") {
			snapshot = await deps.journal.transitionAction(
				command,
				lease,
				index,
				"dispatched",
				"needs_review",
				{
					result: result(
						snapshot,
						index,
						"needs_review",
						reasonCode,
					),
				},
			);
		} else if (
			index !== undefined &&
			state === "observed" &&
			snapshot.actions[index]?.result === undefined
		) {
			snapshot = await deps.journal.setActionResult(
				command,
				lease,
				index,
				result(snapshot, index, "needs_review", reasonCode),
			);
		}
		return deps.journal.skipPending(
			command,
			lease,
			reasonCode,
		);
	};

	const markNeedsReview = async (
		command: MailboxExecutionCommand,
		lease: MailboxExecutionLease,
		snapshot: MailboxExecutionJournalSnapshot,
		index: number,
		reasonCode: MailboxReasonCode,
	): Promise<MailboxExecutionJournalSnapshot> => {
		const state = snapshot.actions[index]?.state;
		if (state !== "dispatched" && state !== "observed") return snapshot;
		return deps.journal.transitionAction(
			command,
			lease,
			index,
			state,
			"needs_review",
			{
				result: result(
					snapshot,
					index,
					"needs_review",
					reasonCode,
				),
			},
		);
	};

	const cleanupUncertain = async (
		command: MailboxExecutionCommand,
		lease: MailboxExecutionLease,
		snapshot: MailboxExecutionJournalSnapshot,
		provider: MailboxExecutionProvider,
		providerScope: ReturnType<typeof scope> & {},
		bindings: Readonly<Record<string, unknown>>,
		index: number,
		runSignal: AbortSignal,
		reasonCode: MailboxReasonCode,
	): Promise<MailboxExecutionJournalSnapshot> => {
		const request = actionRequest(snapshot, providerScope, bindings, index);
		try {
			const observed = projectObservation(
				await bounded(
					runSignal,
					timeoutMs,
					(options) => provider.observe(request, options),
					true,
				),
			);
			if (typeof observed === "string") {
				return markNeedsReview(
					command,
					lease,
					snapshot,
					index,
					observed,
				);
			}
			snapshot = await deps.journal.transitionAction(
				command,
				lease,
				index,
				"dispatched",
				"observed",
				{ observation: observed },
			);
			const verified = projectVerification(
				await bounded(
					runSignal,
					timeoutMs,
					(options) => provider.verifyFresh(request, options),
					true,
				),
			);
			const action = snapshot.actions[index]?.action;
			if (
				typeof verified === "string" ||
				action === undefined ||
				!exactActionDelta(verified, action)
			) {
				return markNeedsReview(
					command,
					lease,
					snapshot,
					index,
					typeof verified === "string"
						? verified
						: "verification_mismatch",
				);
			}
			const authorityFingerprint = await currentFingerprint(
				snapshot,
				providerScope,
				bindings,
				remainingAuthorityScope(snapshot, index),
			);
			if (
				verified.delta.changedAliases.length > 0 &&
				authorityFingerprint.digest ===
					snapshot.authorityFingerprint.digest
			) {
				return markNeedsReview(
					command,
					lease,
					snapshot,
					index,
					"verification_mismatch",
				);
			}
			const authorityScope = remainingAuthorityScope(snapshot, index);
			return deps.journal.transitionAction(
				command,
				lease,
				index,
				"observed",
				"verified",
				{
					verification: linkedVerification(
						verified,
						snapshot.authorityFingerprint,
						authorityFingerprint,
						snapshot.authorityScope,
						authorityScope,
					),
					result: result(snapshot, index, "completed"),
					authorityFingerprint,
					authorityScope,
				},
			);
		} catch {
			return markNeedsReview(
				command,
				lease,
				(await deps.journal.snapshot(command)) ?? snapshot,
				index,
				reasonCode,
			);
		}
	};

	const runCore = async (
		command: MailboxExecutionCommand,
		mode: "start" | "resume",
		runController: AbortController,
	): Promise<MailboxExecutionResult> => {
		const loaded = validateCanonicalMailboxExecutionRevision(
			await deps.loadRevision(command.planAlias, command.revisionAlias),
		);
		if (
			loaded.planAlias !== command.planAlias ||
			loaded.revisionAlias !== command.revisionAlias ||
			(mode === "start" && loaded.state !== "approved")
		) {
			return failed("provider_refused");
		}

		let snapshot = await deps.journal.snapshot(command);
		let binding:
			| Awaited<ReturnType<MailboxExecutionCoordinatorDeps["loadBinding"]>>
			| undefined;
		let providerScope: ReturnType<typeof scope>;
		if (snapshot === undefined) {
			if (loaded.state !== "approved") return failed("provider_refused");
			binding = await deps.loadBinding(
				command.planAlias,
				command.revisionAlias,
			);
			providerScope = scope(binding.scope, loaded.revisionAlias);
			if (
				providerScope === undefined ||
				plain(binding.bindings) === undefined
			) {
				return paused("stale_binding");
			}
			snapshot = await deps.journal.initialize(command, {
				accountAlias: providerScope.accountAlias,
				revision: loaded,
				order: buildMailboxExecutionGraph(loaded.actions),
			});
		}
		let lease = await deps.journal.acquireLease(
			command,
			snapshot.accountAlias,
			`worker:${++ownerCounter}:${Date.parse(deps.now())}`,
		);
		if (lease === undefined) return paused("worker_suspended");
		let heartbeatFailure: unknown;
		const heartbeat = setInterval(() => {
			void deps.journal
				.heartbeat(command, lease!)
				.then((renewed) => {
					lease = renewed;
				})
				.catch((error) => {
					heartbeatFailure = error;
					runController.abort();
				});
		}, deps.journal.heartbeatIntervalMs);

		try {
			snapshot = await reconcile(command, lease, snapshot, loaded.state);
			const reconciledTerminal = terminalResult(snapshot);
			if (reconciledTerminal !== undefined) {
				if (snapshot.debriefStatus !== "available") {
					snapshot = await generateDebrief(
						command,
						lease,
						snapshot,
					);
				}
				return terminalResult(snapshot) ?? reconciledTerminal;
			}

			binding ??= await deps.loadBinding(
				command.planAlias,
				command.revisionAlias,
			);
			providerScope = scope(binding.scope, snapshot.revisionAlias);
			if (
				providerScope === undefined ||
				providerScope.accountAlias !== snapshot.accountAlias ||
				plain(binding.bindings) === undefined
			) {
				return paused("stale_binding");
			}
			const provider = await deps.resolveProvider(providerScope);
			lease = await deps.journal.heartbeat(command, lease);
			if (snapshot.cancelRequested || runController.signal.aborted) {
				for (const entry of snapshot.actions) {
					if (
						entry.state === "dispatched" ||
						entry.state === "observed"
					) {
						snapshot = await cleanupUncertain(
							command,
							lease,
							snapshot,
							provider,
							providerScope,
							binding.bindings,
							entry.index,
							runController.signal,
							"canceled",
						);
					}
				}
				snapshot = await deps.journal.skipPending(
					command,
					lease,
					"canceled",
				);
				return await settle(
					command,
					lease,
					snapshot,
					"canceled",
					"canceled",
				);
			}

			for (const index of snapshot.order) {
				if (heartbeatFailure !== undefined) throw heartbeatFailure;
				snapshot =
					(await deps.journal.snapshot(command)) ?? snapshot;
				const entry = snapshot.actions[index];
				if (
					entry === undefined ||
					entry.state === "verified" ||
					entry.state === "needs_review" ||
					entry.state === "skipped"
				) {
					continue;
				}
				const actionAuthority =
					entry.state === "pending"
						? await checkAuthority(
								snapshot,
								provider,
								providerScope,
								binding.bindings,
								runController.signal,
							)
						: await checkPreflight(
								snapshot,
								provider,
								providerScope,
								binding.bindings,
								runController.signal,
							);
				if (actionAuthority !== undefined) {
					if (actionAuthority.resumable) return actionAuthority;
					const reasonCode =
						actionAuthority.reasonCode ?? "provider_refused";
					snapshot = await prepareFailure(
						command,
						lease,
						snapshot,
						reasonCode,
						index,
					);
					return await settle(
						command,
						lease,
						snapshot,
						"failed",
						reasonCode,
					);
				}
				if (entry.state === "pending") {
					if (snapshot.lifecycleState === "approved") {
						snapshot = await transition(
							command,
							lease,
							snapshot,
							"in_flight",
						);
					}
					if (
						snapshot.cancelRequested ||
						runController.signal.aborted
					) {
						snapshot = await deps.journal.skipPending(
							command,
							lease,
							"canceled",
						);
						return await settle(
							command,
							lease,
							snapshot,
							"canceled",
							"canceled",
						);
					}
					snapshot = await deps.journal.transitionAction(
						command,
						lease,
						index,
						"pending",
						"dispatched",
					);
					const request = actionRequest(
						snapshot,
						providerScope,
						binding.bindings,
						index,
					);
					lease = await deps.journal.heartbeat(command, lease);
					try {
						const dispatched = await bounded(
							runController.signal,
							timeoutMs,
							(options) => provider.dispatch(request, options),
						);
						if (!projectDispatch(dispatched)) {
							throw new Error("Invalid guarded dispatch");
						}
					} catch (error) {
						const reasonCode = reason(
							error,
							runController.signal.aborted
								? "canceled"
								: "provider_timeout",
						);
						snapshot = await cleanupUncertain(
							command,
							lease,
							snapshot,
							provider,
							providerScope,
							binding.bindings,
							index,
							runController.signal,
							reasonCode,
						);
						snapshot = await deps.journal.skipPending(
							command,
							lease,
							reasonCode,
						);
						if (
							snapshot.actions[index]?.state === "dispatched"
						) {
							return paused(reasonCode);
						}
						return await settle(
							command,
							lease,
							snapshot,
							reasonCode === "canceled" ? "canceled" : "failed",
							reasonCode,
						);
					}
				}

				snapshot =
					(await deps.journal.snapshot(command)) ?? snapshot;
				if (snapshot.actions[index]?.state === "dispatched") {
					let observed:
						| MailboxExecutionObservation
						| MailboxReasonCode;
					try {
						observed = projectObservation(
							await bounded(
								runController.signal,
								timeoutMs,
								(options) =>
									provider.observe(
										actionRequest(
											snapshot!,
											providerScope!,
											binding!.bindings,
											index,
										) as MailboxProviderObserveRequest,
										options,
									),
							),
						);
					} catch (error) {
						observed = reason(error, "provider_refused");
					}
					if (typeof observed === "string") {
						snapshot = await markNeedsReview(
							command,
							lease,
							snapshot,
							index,
							observed,
						);
						snapshot = await deps.journal.skipPending(
							command,
							lease,
							observed,
						);
						return await settle(
							command,
							lease,
							snapshot,
							observed === "canceled"
								? "canceled"
								: "failed",
							observed,
						);
					}
					snapshot = await deps.journal.transitionAction(
						command,
						lease,
						index,
						"dispatched",
						"observed",
						{ observation: observed },
					);
				}

				if (snapshot.actions[index]?.state === "observed") {
					let verified:
						| Readonly<{
								verifiedAt: string;
								delta: MailboxProviderActionDelta;
						  }>
						| MailboxReasonCode;
					try {
						verified = projectVerification(
							await bounded(
								runController.signal,
								timeoutMs,
								(options) =>
									provider.verifyFresh(
										actionRequest(
											snapshot!,
											providerScope!,
											binding!.bindings,
											index,
										) as MailboxProviderObserveRequest,
										options,
									),
							),
						);
					} catch (error) {
						verified = reason(error, "provider_timeout");
					}
					const action = snapshot.actions[index]?.action;
					if (
						typeof verified === "string" ||
						action === undefined ||
						!exactActionDelta(verified, action)
					) {
						const reasonCode =
							typeof verified === "string"
								? verified
								: "verification_mismatch";
						snapshot = await markNeedsReview(
							command,
							lease,
							snapshot,
							index,
							reasonCode,
						);
						snapshot = await deps.journal.skipPending(
							command,
							lease,
							reasonCode,
						);
						return await settle(
							command,
							lease,
							snapshot,
							reasonCode === "canceled" ? "canceled" : "failed",
							reasonCode,
						);
					}
					const authorityFingerprint =
						await currentFingerprint(
							snapshot,
							providerScope,
							binding.bindings,
							remainingAuthorityScope(snapshot, index),
						);
					if (
						verified.delta.changedAliases.length > 0 &&
						authorityFingerprint.digest ===
							snapshot.authorityFingerprint.digest
					) {
						snapshot = await markNeedsReview(
							command,
							lease,
							snapshot,
							index,
							"verification_mismatch",
						);
						snapshot = await deps.journal.skipPending(
							command,
							lease,
							"verification_mismatch",
						);
						return await settle(
							command,
							lease,
							snapshot,
							"failed",
							"verification_mismatch",
						);
					}
					const authorityScope =
						remainingAuthorityScope(snapshot, index);
					snapshot = await deps.journal.transitionAction(
						command,
						lease,
						index,
						"observed",
						"verified",
						{
							verification: linkedVerification(
								verified,
								snapshot.authorityFingerprint,
								authorityFingerprint,
								snapshot.authorityScope,
								authorityScope,
							),
							result: result(snapshot, index, "completed"),
							authorityFingerprint,
							authorityScope,
						},
					);
				}
			}

			lease = await deps.journal.heartbeat(command, lease);
			try {
				const inbox = projectInbox(
					await bounded(
						runController.signal,
						timeoutMs,
						(options) =>
							provider.observeInbox(providerScope!, options),
					),
				);
				if (inbox !== undefined) {
					snapshot = await deps.journal.setFinalInboxObservation(
						command,
						lease,
						inbox,
					);
				}
			} catch {
				// Completion is valid, but Inbox Zero is not claimed.
			}
			return await settle(command, lease, snapshot, "completed");
		} catch (error) {
			const reasonCode =
				error instanceof PhaseError
					? error.code === "provider_canceled"
						? "canceled"
						: "provider_timeout"
					: reason(
							error,
							runController.signal.aborted ||
								snapshot.cancelRequested
								? "canceled"
								: "internal_failure",
						);
			if (
				error instanceof MailboxExecutionJournalError &&
				(error.code === "lease_lost" ||
					error.code === "lease_unavailable")
			) {
				return paused("worker_suspended");
			}
			if (
				error instanceof MailboxExecutionJournalError &&
				error.code === "invalid_snapshot"
			) {
				return failed("internal_failure");
			}
			try {
				lease = await deps.journal.heartbeat(command, lease);
				snapshot =
					(await deps.journal.snapshot(command)) ?? snapshot;
				if (
					snapshot.lifecycleIntent !== undefined ||
					snapshot.terminalStatus !== undefined
				) {
					return failed(reasonCode);
				}
				for (const entry of snapshot.actions) {
					if (
						entry.state === "dispatched" ||
						(entry.state === "observed" &&
							entry.result === undefined)
					) {
						snapshot = await prepareFailure(
							command,
							lease,
							snapshot,
							reasonCode,
							entry.index,
						);
					}
				}
				snapshot = await prepareFailure(
					command,
					lease,
					snapshot,
					reasonCode,
				);
				return await settle(
					command,
					lease,
					snapshot,
					reasonCode === "canceled" ? "canceled" : "failed",
					reasonCode,
				);
			} catch {
				return failed(reasonCode);
			}
		} finally {
			clearInterval(heartbeat);
			await deps.journal
				.releaseLease(command, lease)
				.catch(() => undefined);
		}
	};

	const run = (
		command: MailboxExecutionCommand,
		mode: "start" | "resume",
		controller: AbortController,
	): Promise<MailboxExecutionResult> =>
		runCore(command, mode, controller).catch(async (error) => {
			if (
				error instanceof MailboxExecutionJournalError &&
				(error.code === "lease_lost" ||
					error.code === "lease_unavailable")
			) {
				return paused("worker_suspended");
			}
			return failed(
				error instanceof PhaseError
					? error.code === "provider_canceled"
						? "canceled"
						: "provider_timeout"
					: "internal_failure",
			);
		});

	const runOrJoin = (
		command: MailboxExecutionCommand,
		mode: "start" | "resume",
	): Promise<MailboxExecutionResult> => {
		if (!validCommand(command)) return Promise.resolve(failed());
		const existing = active.get(key(command));
		if (existing !== undefined) return existing.promise;
		const controller = new AbortController();
		const promise = run(command, mode, controller).finally(() => {
			if (active.get(key(command))?.promise === promise) {
				active.delete(key(command));
			}
		});
		active.set(key(command), Object.freeze({ controller, promise }));
		return promise;
	};

	return Object.freeze({
		start: (command) => runOrJoin(command, "start"),
		resume: (command) => runOrJoin(command, "resume"),
		async cancel(command) {
			if (!validCommand(command)) return failed();
			const current = active.get(key(command));
			current?.controller.abort();
			try {
				await deps.journal.requestCancel(command);
			} catch (error) {
				if (
					current !== undefined &&
					error instanceof MailboxExecutionJournalError &&
					error.code === "invalid_snapshot"
				) {
					return Object.freeze({
						status: "canceled",
						reasonCode: "canceled",
						resumable: false,
					});
				}
				return failed("internal_failure");
			}
			return current === undefined
				? runOrJoin(command, "resume")
				: paused("canceled");
		},
		async status(command) {
			if (!validCommand(command)) return failed();
			try {
				const snapshot = await deps.journal.snapshot(command);
				return snapshot === undefined
					? paused("worker_suspended")
					: terminalResult(snapshot) ?? paused("worker_suspended");
			} catch {
				return failed("internal_failure");
			}
		},
		async recoverActive() {
			const commands = await deps.journal.activeCommands();
			return Promise.all(
				commands.map(async (command) =>
					Object.freeze({
						command,
						result: await runOrJoin(command, "resume"),
					}),
				),
			);
		},
	});
}
