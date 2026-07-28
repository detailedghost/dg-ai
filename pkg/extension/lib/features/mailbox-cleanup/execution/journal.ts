import {
	MAILBOX_REASON_CODES,
	MAILBOX_RESULT_STATUSES,
	type MailboxReasonCode,
} from "@dg/common";
import {
	MailboxExecutionJournalError,
	type MailboxExecutionActionJournal,
	type MailboxExecutionActionResult,
	type MailboxExecutionActionState,
	type MailboxExecutionAuthorityScope,
	type MailboxExecutionAtomicRecord,
	type MailboxExecutionAtomicStorage,
	type MailboxExecutionCommand,
	type MailboxExecutionJournal,
	type MailboxExecutionJournalSnapshot,
	type MailboxExecutionLease,
	type MailboxExecutionLifecycleState,
	type MailboxExecutionTerminalStatus,
} from "./contracts";
import {
	buildMailboxExecutionAuthorityScope,
	validateCanonicalMailboxExecutionRevision,
} from "./graph";

const PLAN_ALIAS = /^plan_[a-f0-9]{32}$/;
const REVISION_ALIAS = /^rev_[a-f0-9]{32}$/;
const ACCOUNT_ALIAS = /^acct_[a-f0-9]{32}$/;
const OWNER = /^[a-zA-Z0-9:._-]{1,160}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UNIT_SIZE = 100;
const DEFAULT_LEASE_DURATION_MS = 30_000;
const MAX_CAS_ATTEMPTS = 32;
const ACTIVE_INDEX_KEY = "dg:mailbox-execution:v2:active";

type PlainRecord = Record<string, unknown>;

function fail(
	code: ConstructorParameters<typeof MailboxExecutionJournalError>[0],
): never {
	throw new MailboxExecutionJournalError(code);
}

function deepFreeze<T>(value: T): T {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
		return value;
	}
	for (const child of Object.values(value as Record<string, unknown>)) {
		deepFreeze(child);
	}
	return Object.freeze(value);
}

function clone<T>(value: T): T {
	return deepFreeze(structuredClone(value));
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
	value: PlainRecord,
	required: readonly string[],
	optional: readonly string[] = [],
): boolean {
	const allowed = new Set([...required, ...optional]);
	return (
		required.every((field) => Object.hasOwn(value, field)) &&
		Object.keys(value).every((field) => allowed.has(field))
	);
}

function isTimestamp(value: unknown): value is string {
	return (
		typeof value === "string" &&
		TIMESTAMP.test(value) &&
		new Date(value).toISOString() === value
	);
}

function key(command: MailboxExecutionCommand): string {
	if (
		!PLAN_ALIAS.test(command.planAlias) ||
		!REVISION_ALIAS.test(command.revisionAlias)
	) {
		fail("invalid_snapshot");
	}
	return `dg:mailbox-execution:v2:${command.planAlias}:${command.revisionAlias}`;
}

function validCommand(value: unknown): value is MailboxExecutionCommand {
	const input = plain(value);
	return (
		input !== undefined &&
		exact(input, ["planAlias", "revisionAlias"]) &&
		typeof input.planAlias === "string" &&
		PLAN_ALIAS.test(input.planAlias) &&
		typeof input.revisionAlias === "string" &&
		REVISION_ALIAS.test(input.revisionAlias)
	);
}

function commandIdentity(command: MailboxExecutionCommand): string {
	return `${command.planAlias}:${command.revisionAlias}`;
}

function unitState(
	entries: readonly MailboxExecutionActionJournal[],
): "pending" | "in_flight" | "verified" {
	if (
		entries.length > 0 &&
		entries.every(
			(entry) =>
				entry.state === "verified" ||
				entry.state === "needs_review" ||
				entry.state === "skipped",
		)
	) {
		return "verified";
	}
	return entries.some((entry) => entry.state !== "pending")
		? "in_flight"
		: "pending";
}

function unitsFor(
	order: readonly number[],
	actions: readonly MailboxExecutionActionJournal[],
): MailboxExecutionJournalSnapshot["units"] {
	return Object.freeze(
		Array.from(
			{ length: Math.ceil(order.length / UNIT_SIZE) },
			(_, unitIndex) => {
				const startIndex = unitIndex * UNIT_SIZE;
				const endIndex = Math.min(
					order.length - 1,
					startIndex + UNIT_SIZE - 1,
				);
				return Object.freeze({
					startIndex,
					endIndex,
					state: unitState(
						order
							.slice(startIndex, endIndex + 1)
							.flatMap((index) =>
								actions[index] === undefined ? [] : [actions[index]],
							),
					),
				});
			},
		),
	);
}

function withUnits(
	value: MailboxExecutionJournalSnapshot,
): MailboxExecutionJournalSnapshot {
	return {
		...value,
		unitSize: UNIT_SIZE,
		units: unitsFor(value.order, value.actions),
	};
}

function validReason(value: unknown): value is MailboxReasonCode {
	return (
		typeof value === "string" &&
		MAILBOX_REASON_CODES.includes(
			value as (typeof MAILBOX_REASON_CODES)[number],
		)
	);
}

function validResult(
	value: unknown,
	index: number,
	action: MailboxExecutionActionJournal["action"],
): value is MailboxExecutionActionResult {
	const input = plain(value);
	if (
		input === undefined ||
		!exact(
			input,
			["schemaVersion", "index", "action", "status", "affectedCount"],
			["reasonCode"],
		) ||
		input.schemaVersion !== 1 ||
		input.index !== index ||
		JSON.stringify(input.action) !== JSON.stringify(action) ||
		typeof input.status !== "string" ||
		!MAILBOX_RESULT_STATUSES.includes(
			input.status as (typeof MAILBOX_RESULT_STATUSES)[number],
		) ||
		typeof input.affectedCount !== "number" ||
		!Number.isSafeInteger(input.affectedCount) ||
		input.affectedCount < 0
	) {
		return false;
	}
	return input.reasonCode === undefined || validReason(input.reasonCode);
}

function validObservation(value: unknown): boolean {
	const input = plain(value);
	return (
		input !== undefined &&
		exact(input, ["status", "observedAt"]) &&
		input.status === "observed" &&
		isTimestamp(input.observedAt)
	);
}

function validVerification(value: unknown): boolean {
	const input = plain(value);
	if (
		input === undefined ||
		!exact(input, ["status", "verifiedAt", "delta"]) ||
		input.status !== "verified" ||
		!isTimestamp(input.verifiedAt)
	) {
		return false;
	}
	const delta = plain(input.delta);
	if (
		delta === undefined ||
		!exact(delta, [
			"schemaVersion",
			"scope",
			"actionAlias",
			"changedAliases",
			"beforeFingerprint",
			"afterFingerprint",
			"beforeScope",
			"afterScope",
		]) ||
		delta.schemaVersion !== 1 ||
		delta.scope !== "entire_fingerprint" ||
		typeof delta.actionAlias !== "string" ||
		!/^act_[a-f0-9]{32}$/.test(delta.actionAlias) ||
		!Array.isArray(delta.changedAliases) ||
		new Set(delta.changedAliases).size !== delta.changedAliases.length ||
		delta.changedAliases.some(
			(alias) =>
				typeof alias !== "string" ||
				!/^(?:msg|fld|lbl|flt)_[a-f0-9]{32}$/.test(alias),
		)
	) {
		return false;
	}
	return (
		[delta.beforeFingerprint, delta.afterFingerprint].every((value) => {
		const fingerprint = plain(value);
		return (
			fingerprint !== undefined &&
			exact(fingerprint, ["schemaVersion", "algorithm", "digest"]) &&
			fingerprint.schemaVersion === 1 &&
			fingerprint.algorithm === "sha256" &&
			typeof fingerprint.digest === "string" &&
			SHA256.test(fingerprint.digest)
		);
		}) &&
		validAuthorityScope(delta.beforeScope) &&
		validAuthorityScope(delta.afterScope)
	);
}

function validAuthorityScope(
	value: unknown,
): value is MailboxExecutionAuthorityScope {
	const input = plain(value);
	if (
		input === undefined ||
		!exact(input, ["schemaVersion", "actionAliases", "targets"]) ||
		input.schemaVersion !== 1 ||
		!Array.isArray(input.actionAliases) ||
		input.actionAliases.length > 10_000 ||
		new Set(input.actionAliases).size !== input.actionAliases.length ||
		input.actionAliases.some(
			(alias) =>
				typeof alias !== "string" ||
				!/^act_[a-f0-9]{32}$/.test(alias),
		)
	) {
		return false;
	}
	const targets = plain(input.targets);
	if (
		targets === undefined ||
		!exact(targets, [
			"folderAliases",
			"labelAliases",
			"filterAliases",
		])
	) {
		return false;
	}
	for (const [field, pattern] of [
		["folderAliases", /^fld_[a-f0-9]{32}$/],
		["labelAliases", /^lbl_[a-f0-9]{32}$/],
		["filterAliases", /^flt_[a-f0-9]{32}$/],
	] as const) {
		const aliases = targets[field];
		if (
			!Array.isArray(aliases) ||
			aliases.length > 10_000 ||
			new Set(aliases).size !== aliases.length ||
			aliases.some(
				(alias) =>
					typeof alias !== "string" || !pattern.test(alias),
			) ||
			aliases.some(
				(alias, index) =>
					index > 0 &&
					String(aliases[index - 1]).localeCompare(
						String(alias),
					) >= 0,
			)
		) {
			return false;
		}
	}
	return true;
}

function validInboxObservation(value: unknown): boolean {
	const input = plain(value);
	return (
		input !== undefined &&
		exact(input, ["status", "count", "observedAt"]) &&
		input.status === "observed" &&
		typeof input.count === "number" &&
		Number.isSafeInteger(input.count) &&
		input.count >= 0 &&
		isTimestamp(input.observedAt)
	);
}

function validActionEntry(
	value: unknown,
	index: number,
	revisionAction: unknown,
): value is MailboxExecutionActionJournal {
	const input = plain(value);
	if (
		input === undefined ||
		!exact(input, ["index", "action", "state"], [
			"observation",
			"verification",
			"result",
		]) ||
		input.index !== index ||
		JSON.stringify(input.action) !== JSON.stringify(revisionAction) ||
		![
			"pending",
			"dispatched",
			"observed",
			"verified",
			"needs_review",
			"skipped",
		].includes(String(input.state))
	) {
		return false;
	}
	const hasObservation = Object.hasOwn(input, "observation");
	const hasVerification = Object.hasOwn(input, "verification");
	const hasResult = Object.hasOwn(input, "result");
	switch (input.state) {
		case "pending":
		case "dispatched":
			return !hasObservation && !hasVerification && !hasResult;
		case "observed":
			return (
				hasObservation &&
				validObservation(input.observation) &&
				!hasVerification &&
				(!hasResult ||
					validResult(
						input.result,
						index,
						input.action as MailboxExecutionActionJournal["action"],
					))
			);
		case "verified":
			return (
				hasObservation &&
				validObservation(input.observation) &&
				hasVerification &&
				validVerification(input.verification) &&
				(input.verification as MailboxExecutionJournalSnapshot["actions"][number]["verification"])
					?.delta.actionAlias ===
					(input.action as MailboxExecutionActionJournal["action"]).actionAlias &&
				hasResult &&
				validResult(
					input.result,
					index,
					input.action as MailboxExecutionActionJournal["action"],
				) &&
				(input.result as { status: unknown }).status === "completed"
			);
		case "needs_review":
			return (
				(!hasObservation || validObservation(input.observation)) &&
				!hasVerification &&
				hasResult &&
				validResult(
					input.result,
					index,
					input.action as MailboxExecutionActionJournal["action"],
				) &&
				(input.result as { status: unknown }).status === "needs_review"
			);
		case "skipped":
			return (
				!hasObservation &&
				!hasVerification &&
				hasResult &&
				validResult(
					input.result,
					index,
					input.action as MailboxExecutionActionJournal["action"],
				) &&
				(input.result as { status: unknown }).status === "skipped"
			);
		default:
			return false;
	}
}

function validLease(value: unknown): value is MailboxExecutionLease {
	const input = plain(value);
	return (
		input !== undefined &&
		exact(input, ["owner", "fence", "expiresAt"]) &&
		typeof input.owner === "string" &&
		OWNER.test(input.owner) &&
		typeof input.fence === "number" &&
		Number.isSafeInteger(input.fence) &&
		input.fence > 0 &&
		isTimestamp(input.expiresAt)
	);
}

function validIntent(
	value: unknown,
	state: MailboxExecutionLifecycleState,
): boolean {
	const input = plain(value);
	if (
		input !== undefined &&
		exact(
			input,
			["expected", "next", "createdAt"],
			["terminalStatus", "terminalReasonCode"],
		) &&
		input.expected === state &&
		(input.expected === "approved" || input.expected === "in_flight") &&
		(input.next === "in_flight" ||
			input.next === "completed" ||
			input.next === "canceled") &&
		isTimestamp(input.createdAt)
	) {
		const terminalStatus = input.terminalStatus;
		const terminalReasonCode = input.terminalReasonCode;
		if (input.next === "in_flight") {
			return terminalStatus === undefined && terminalReasonCode === undefined;
		}
		if (
			!["completed", "failed", "canceled"].includes(
				String(terminalStatus),
			) ||
			(terminalReasonCode !== undefined &&
				!validReason(terminalReasonCode))
		) {
			return false;
		}
		return input.next === "completed"
			? terminalStatus === "completed" &&
					terminalReasonCode === undefined
			: terminalStatus !== "completed";
	}
	return false;
}

function validateSnapshot(
	value: unknown,
	command?: MailboxExecutionCommand,
	revisionCache?: {
		serialized?: string;
		revision?: MailboxExecutionJournalSnapshot["revision"];
	},
): MailboxExecutionJournalSnapshot {
	const input = plain(value);
	if (
		input === undefined ||
		!exact(
			input,
			[
				"schemaVersion",
				"planAlias",
				"revisionAlias",
				"accountAlias",
				"revision",
				"authorityFingerprint",
				"authorityScope",
				"order",
				"unitSize",
				"units",
				"actions",
				"cancelRequested",
				"lifecycleState",
				"nextFence",
				"debriefStatus",
				"updatedAt",
			],
			[
				"lifecycleIntent",
				"lease",
				"terminalStatus",
				"terminalReasonCode",
				"finalInboxObservation",
			],
		) ||
		input.schemaVersion !== 1 ||
		typeof input.planAlias !== "string" ||
		!PLAN_ALIAS.test(input.planAlias) ||
		typeof input.revisionAlias !== "string" ||
		!REVISION_ALIAS.test(input.revisionAlias) ||
		(command !== undefined &&
			(input.planAlias !== command.planAlias ||
				input.revisionAlias !== command.revisionAlias)) ||
		typeof input.accountAlias !== "string" ||
		!ACCOUNT_ALIAS.test(input.accountAlias) ||
		typeof input.cancelRequested !== "boolean" ||
		typeof input.nextFence !== "number" ||
		!Number.isSafeInteger(input.nextFence) ||
		input.nextFence < 1 ||
		!["approved", "in_flight", "completed", "canceled"].includes(
			String(input.lifecycleState),
		) ||
		!["pending", "available", "failed"].includes(
			String(input.debriefStatus),
		) ||
		!isTimestamp(input.updatedAt) ||
		input.unitSize !== UNIT_SIZE ||
		!Array.isArray(input.order) ||
		!Array.isArray(input.actions) ||
		!Array.isArray(input.units)
	) {
		fail("invalid_snapshot");
	}
	const authorityFingerprint = plain(input.authorityFingerprint);
	if (
		authorityFingerprint === undefined ||
		!exact(authorityFingerprint, [
			"schemaVersion",
			"algorithm",
			"digest",
		]) ||
		authorityFingerprint.schemaVersion !== 1 ||
		authorityFingerprint.algorithm !== "sha256" ||
		typeof authorityFingerprint.digest !== "string" ||
		!SHA256.test(authorityFingerprint.digest)
	) {
		fail("invalid_snapshot");
	}
	if (!validAuthorityScope(input.authorityScope)) {
		fail("invalid_snapshot");
	}

	let serializedRevision: string;
	try {
		serializedRevision = JSON.stringify(input.revision);
	} catch {
		fail("invalid_snapshot");
	}
	let revision =
		revisionCache?.serialized === serializedRevision
			? revisionCache.revision
			: undefined;
	if (revision === undefined) {
		try {
			revision = validateCanonicalMailboxExecutionRevision(
				input.revision,
			);
		} catch {
			fail("invalid_snapshot");
		}
		if (revisionCache !== undefined) {
			revisionCache.serialized = serializedRevision;
			revisionCache.revision = revision;
		}
	}
	if (
		revision.planAlias !== input.planAlias ||
		revision.revisionAlias !== input.revisionAlias ||
		input.actions.length !== revision.actions.length ||
		input.order.length !== input.actions.length
	) {
		fail("invalid_snapshot");
	}
	const actionCount = input.actions.length;
	if (
		new Set(input.order).size !== input.order.length ||
		input.order.some(
			(index) =>
				typeof index !== "number" ||
				!Number.isSafeInteger(index) ||
				index < 0 ||
				index >= actionCount,
		) ||
		input.actions.some(
			(entry, index) =>
				!validActionEntry(entry, index, revision.actions[index]),
		)
	) {
		fail("invalid_snapshot");
	}
	const actions = input.actions as unknown as readonly MailboxExecutionActionJournal[];
	let chainedFingerprint = revision.inventoryFingerprint;
	let chainedScope = buildMailboxExecutionAuthorityScope(
		(input.order as number[]).map((index) => revision.actions[index]!),
	);
	for (const [position, index] of (
		input.order as number[]
	).entries()) {
		const entry = actions[index];
		if (entry?.state !== "verified" || entry.verification === undefined) {
			continue;
		}
		const delta = entry.verification.delta;
		const expectedAfterScope =
			buildMailboxExecutionAuthorityScope(
				(input.order as number[])
					.slice(position + 1)
					.map((remainingIndex) => revision.actions[remainingIndex]!),
			);
		if (
			delta.actionAlias !== entry.action.actionAlias ||
			delta.beforeFingerprint.digest !== chainedFingerprint.digest ||
			JSON.stringify(delta.beforeScope) !==
				JSON.stringify(chainedScope) ||
			JSON.stringify(delta.afterScope) !==
				JSON.stringify(expectedAfterScope) ||
			(delta.changedAliases.length > 0 &&
				delta.afterFingerprint.digest ===
					delta.beforeFingerprint.digest)
		) {
			fail("invalid_snapshot");
		}
		chainedFingerprint = delta.afterFingerprint;
		chainedScope = delta.afterScope;
	}
	if (
		chainedFingerprint.digest !==
			(authorityFingerprint.digest as string) ||
		JSON.stringify(input.authorityScope) !==
			JSON.stringify(chainedScope)
	) {
		fail("invalid_snapshot");
	}
	const expectedUnits = unitsFor(input.order as number[], actions);
	if (JSON.stringify(input.units) !== JSON.stringify(expectedUnits)) {
		fail("invalid_snapshot");
	}
	if (
		(input.lease !== undefined && !validLease(input.lease)) ||
		(input.lifecycleIntent !== undefined &&
			!validIntent(
				input.lifecycleIntent,
				input.lifecycleState as MailboxExecutionLifecycleState,
			)) ||
		(input.finalInboxObservation !== undefined &&
			!validInboxObservation(input.finalInboxObservation)) ||
		(input.terminalReasonCode !== undefined &&
			!validReason(input.terminalReasonCode))
	) {
		fail("invalid_snapshot");
	}
	const terminal = input.terminalStatus;
	if (
		terminal !== undefined &&
		!["completed", "failed", "canceled"].includes(String(terminal))
	) {
		fail("invalid_snapshot");
	}
	const unsettled = actions.some(
		(action) =>
			action.state === "pending" || action.state === "dispatched",
	);
	if (terminal === undefined) {
		if (
			input.lifecycleState === "completed" ||
			input.lifecycleState === "canceled" ||
			input.debriefStatus !== "pending"
		) {
			fail("invalid_snapshot");
		}
	} else {
		const target = terminal === "completed" ? "completed" : "canceled";
		const intent = plain(input.lifecycleIntent);
		const lifecycleSettled =
			input.lifecycleState === target && intent === undefined;
		const lifecyclePrepared =
			intent !== undefined &&
			intent.expected === input.lifecycleState &&
			intent.next === target;
		if (unsettled || (!lifecycleSettled && !lifecyclePrepared)) {
			fail("invalid_snapshot");
		}
		if (
			terminal === "completed" &&
			!actions.every(
				(action) =>
					action.state === "verified" &&
					action.result?.status === "completed",
			)
		) {
			fail("invalid_snapshot");
		}
	}
	return clone({
		...input,
		revision,
		actions,
		order: Object.freeze([...(input.order as number[])]),
		units: expectedUnits,
	} as MailboxExecutionJournalSnapshot);
}

function sameAuthority(
	left: MailboxExecutionJournalSnapshot,
	right: Readonly<{
		accountAlias: string;
		revision: MailboxExecutionJournalSnapshot["revision"];
		order: readonly number[];
	}>,
): boolean {
	return (
		left.accountAlias === right.accountAlias &&
		JSON.stringify(left.revision) === JSON.stringify(right.revision) &&
		JSON.stringify(left.order) === JSON.stringify(right.order)
	);
}

type ActiveIndex = Readonly<{
	schemaVersion: 1;
	commands: readonly MailboxExecutionCommand[];
}>;

const ACTIVE_INDEX_LIMIT = 10_000;

function validateActiveIndex(value: unknown): ActiveIndex {
	const input = plain(value);
	if (
		input === undefined ||
		!exact(input, ["schemaVersion", "commands"]) ||
		input.schemaVersion !== 1 ||
		!Array.isArray(input.commands) ||
		input.commands.length > ACTIVE_INDEX_LIMIT ||
		input.commands.some((command) => !validCommand(command))
	) {
		fail("invalid_snapshot");
	}
	const commands = [...input.commands] as MailboxExecutionCommand[];
	const identities = commands.map(commandIdentity);
	if (
		new Set(identities).size !== identities.length ||
		identities.some(
			(identity, index) =>
				index > 0 && identities[index - 1]!.localeCompare(identity) >= 0,
		)
	) {
		fail("invalid_snapshot");
	}
	return clone({
		schemaVersion: 1,
		commands: Object.freeze(commands),
	});
}

export function createMailboxExecutionJournal(deps: Readonly<{
	storage: MailboxExecutionAtomicStorage;
	now(): string;
	leaseDurationMs?: number;
}>): MailboxExecutionJournal {
	const leaseDurationMs =
		deps.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
	const revisionCache: {
		serialized?: string;
		revision?: MailboxExecutionJournalSnapshot["revision"];
	} = {};
	if (
		!Number.isSafeInteger(leaseDurationMs) ||
		leaseDurationMs < 30 ||
		leaseDurationMs > 5 * 60_000
	) {
		fail("storage_failure");
	}

	const nowMilliseconds = (): number => {
		const value = Date.parse(deps.now());
		if (!Number.isFinite(value)) fail("storage_failure");
		return value;
	};

	const readAtomic = async (
		command: MailboxExecutionCommand,
	): Promise<MailboxExecutionAtomicRecord | undefined> => {
		try {
			const value = await deps.storage.read(key(command));
			if (
				value !== undefined &&
				(!Number.isSafeInteger(value.version) || value.version < 0)
			) {
				fail("invalid_snapshot");
			}
			return value;
		} catch (error) {
			if (error instanceof MailboxExecutionJournalError) throw error;
			fail("storage_failure");
		}
	};

	const compareAndSet = async (
		command: MailboxExecutionCommand,
		expectedVersion: number | undefined,
		value: MailboxExecutionJournalSnapshot,
	): Promise<boolean> => {
		try {
			return await deps.storage.compareAndSet(
				key(command),
				expectedVersion,
				clone(withUnits(value)),
			);
		} catch {
			fail("storage_failure");
		}
	};

	const readIndexAtomic = async (): Promise<
		MailboxExecutionAtomicRecord | undefined
	> => {
		try {
			const value = await deps.storage.read(ACTIVE_INDEX_KEY);
			if (
				value !== undefined &&
				(!Number.isSafeInteger(value.version) || value.version < 0)
			) {
				fail("invalid_snapshot");
			}
			return value;
		} catch (error) {
			if (error instanceof MailboxExecutionJournalError) throw error;
			fail("storage_failure");
		}
	};

	const mutateActiveIndex = async (
		operation: (commands: readonly MailboxExecutionCommand[]) =>
			readonly MailboxExecutionCommand[],
	): Promise<void> => {
		for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
			const stored = await readIndexAtomic();
			const current =
				stored === undefined
					? Object.freeze({
							schemaVersion: 1 as const,
							commands: Object.freeze([]),
						})
					: validateActiveIndex(stored.value);
			const commands = [...operation(current.commands)].sort((left, right) =>
				commandIdentity(left).localeCompare(commandIdentity(right)),
			);
			const next = validateActiveIndex({
				schemaVersion: 1,
				commands,
			});
			try {
				if (
					await deps.storage.compareAndSet(
						ACTIVE_INDEX_KEY,
						stored?.version,
						next,
					)
				) {
					return;
				}
			} catch {
				fail("storage_failure");
			}
		}
		fail("conflict");
	};

	const ensureActive = (command: MailboxExecutionCommand): Promise<void> =>
		mutateActiveIndex((commands) =>
			commands.some(
				(candidate) => commandIdentity(candidate) === commandIdentity(command),
			)
				? commands
				: Object.freeze([...commands, clone(command)]),
		);

	const removeActive = (command: MailboxExecutionCommand): Promise<void> =>
		mutateActiveIndex((commands) =>
			Object.freeze(
				commands.filter(
					(candidate) =>
						commandIdentity(candidate) !== commandIdentity(command),
				),
			),
		);

	const mutate = async (
		command: MailboxExecutionCommand,
		lease: MailboxExecutionLease | undefined,
		operation: (
			current: MailboxExecutionJournalSnapshot,
		) => MailboxExecutionJournalSnapshot,
		options: Readonly<{ allowExpiredLease?: boolean }> = {},
	): Promise<MailboxExecutionJournalSnapshot> => {
		for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
			const stored = await readAtomic(command);
			if (stored === undefined) fail("invalid_snapshot");
			const current = validateSnapshot(
				stored.value,
				command,
				revisionCache,
			);
			if (lease !== undefined) {
				if (
					current.lease?.owner !== lease.owner ||
					current.lease.fence !== lease.fence
				) {
					fail("lease_lost");
				}
				if (
					!options.allowExpiredLease &&
					Date.parse(current.lease.expiresAt) <= nowMilliseconds()
				) {
					fail("lease_lost");
				}
			}
			const next = validateSnapshot(
				withUnits(operation(current)),
				command,
				revisionCache,
			);
			if (await compareAndSet(command, stored.version, next)) return next;
		}
		fail("conflict");
	};

	const snapshot = async (
		command: MailboxExecutionCommand,
	): Promise<MailboxExecutionJournalSnapshot | undefined> => {
		const stored = await readAtomic(command);
		return stored === undefined
			? undefined
			: validateSnapshot(stored.value, command, revisionCache);
	};

	const leaseExpiry = (): string =>
		new Date(nowMilliseconds() + leaseDurationMs).toISOString();

	return Object.freeze({
		heartbeatIntervalMs: Math.max(10, Math.floor(leaseDurationMs / 3)),
		async activeCommands() {
			const stored = await readIndexAtomic();
			if (stored === undefined) return Object.freeze([]);
			const indexed = validateActiveIndex(stored.value);
			const active: MailboxExecutionCommand[] = [];
			for (const command of indexed.commands) {
				const current = await snapshot(command);
				if (
					current !== undefined &&
					(current.terminalStatus === undefined ||
						current.debriefStatus !== "available")
				) {
					active.push(command);
				}
			}
			return Object.freeze(active);
		},
		snapshot,
		async initialize(command, input) {
			await ensureActive(command);
			for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
				const stored = await readAtomic(command);
				if (stored !== undefined) {
					const current = validateSnapshot(
						stored.value,
						command,
						revisionCache,
					);
					if (!sameAuthority(current, input)) fail("invalid_snapshot");
					return current;
				}
				if (!ACCOUNT_ALIAS.test(input.accountAlias)) {
					fail("invalid_snapshot");
				}
				const actions = Object.freeze(
					input.revision.actions.map((action, index) =>
						Object.freeze({
							index,
							action,
							state: "pending" as const,
						}),
					),
				);
				const next = validateSnapshot(
					withUnits({
						schemaVersion: 1,
						...command,
						accountAlias: input.accountAlias,
						revision: input.revision,
						authorityFingerprint:
							input.revision.inventoryFingerprint,
						authorityScope:
							buildMailboxExecutionAuthorityScope(
								input.order.map(
									(index) =>
										input.revision.actions[index]!,
								),
							),
						order: Object.freeze([...input.order]),
						unitSize: UNIT_SIZE,
						units: Object.freeze([]),
						actions,
						cancelRequested: false,
						lifecycleState: "approved",
						nextFence: 1,
						debriefStatus: "pending",
						updatedAt: deps.now(),
					}),
					command,
					revisionCache,
				);
				if (await compareAndSet(command, undefined, next)) return next;
			}
			fail("conflict");
		},
		async acquireLease(command, accountAlias, owner) {
			if (!ACCOUNT_ALIAS.test(accountAlias) || !OWNER.test(owner)) {
				fail("invalid_snapshot");
			}
			let acquired: MailboxExecutionLease | undefined;
			await mutate(command, undefined, (current) => {
				acquired = undefined;
				if (current.accountAlias !== accountAlias) {
					fail("invalid_snapshot");
				}
				if (
					current.lease !== undefined &&
					Date.parse(current.lease.expiresAt) > nowMilliseconds()
				) {
					return current;
				}
				acquired = Object.freeze({
					owner,
					fence: current.nextFence,
					expiresAt: leaseExpiry(),
				});
				return {
					...current,
					lease: acquired,
					nextFence: current.nextFence + 1,
					updatedAt: deps.now(),
				};
			});
			return acquired;
		},
		async heartbeat(command, lease) {
			let renewed: MailboxExecutionLease | undefined;
			await mutate(command, lease, (current) => {
				renewed = Object.freeze({
					...lease,
					expiresAt: leaseExpiry(),
				});
				return {
					...current,
					lease: renewed,
					updatedAt: deps.now(),
				};
			});
			if (renewed === undefined) fail("lease_lost");
			return renewed;
		},
		async releaseLease(command, lease) {
			await mutate(
				command,
				lease,
				(current) => {
					const { lease: _lease, ...rest } = current;
					return { ...rest, updatedAt: deps.now() };
				},
				{ allowExpiredLease: true },
			);
		},
		async requestCancel(command) {
			let found = false;
			await mutate(command, undefined, (current) => {
				if (current.terminalStatus !== undefined) return current;
				found = true;
				return {
					...current,
					cancelRequested: true,
					updatedAt: deps.now(),
				};
			});
			return found;
		},
		async prepareLifecycle(command, lease, expected, next, terminal) {
			return mutate(command, lease, (current) => {
				if (
					current.lifecycleState !== expected ||
					current.lifecycleIntent !== undefined
				) {
					fail("invalid_snapshot");
				}
				return {
					...current,
					lifecycleIntent: Object.freeze({
						expected,
						next,
						createdAt: deps.now(),
						...(terminal === undefined
							? {}
							: {
									terminalStatus: terminal.status,
									...(terminal.reasonCode === undefined
										? {}
										: {
												terminalReasonCode:
													terminal.reasonCode,
											}),
								}),
					}),
					updatedAt: deps.now(),
				};
			});
		},
		async commitLifecycle(command, lease, expected, next) {
			return mutate(command, lease, (current) => {
				if (
					current.lifecycleState !== expected ||
					current.lifecycleIntent?.expected !== expected ||
					current.lifecycleIntent.next !== next
				) {
					fail("invalid_snapshot");
				}
				const { lifecycleIntent: _intent, ...rest } = current;
				return {
					...rest,
					lifecycleState: next,
					updatedAt: deps.now(),
				};
			});
		},
		async transitionAction(
			command,
			lease,
			index,
			expected,
			next,
			patch = {},
		) {
			return mutate(command, lease, (current) => {
				const action = current.actions[index];
				if (action === undefined || action.state !== expected) {
					fail("invalid_snapshot");
				}
				const allowed: Readonly<
					Record<MailboxExecutionActionState, readonly MailboxExecutionActionState[]>
				> = {
					pending: ["dispatched", "skipped"],
					dispatched: ["observed", "needs_review"],
					observed: ["verified", "needs_review"],
					verified: [],
					needs_review: [],
					skipped: [],
				};
				if (!allowed[expected].includes(next)) fail("invalid_snapshot");
				const actions = [...current.actions];
				const {
					authorityFingerprint,
					authorityScope,
					...actionPatch
				} = patch;
				if (
					(authorityFingerprint === undefined) !==
					(authorityScope === undefined)
				) {
					fail("invalid_snapshot");
				}
				actions[index] = Object.freeze({
					...action,
					...actionPatch,
					state: next,
				});
				return {
					...current,
					...(authorityFingerprint === undefined
						? {}
						: { authorityFingerprint }),
					...(authorityScope === undefined
						? {}
						: { authorityScope }),
					actions: Object.freeze(actions),
					updatedAt: deps.now(),
				};
			});
		},
		async setActionResult(command, lease, index, result) {
			return mutate(command, lease, (current) => {
				const action = current.actions[index];
				if (
					action === undefined ||
					action.state !== "observed" ||
					!validResult(result, index, action.action)
				) {
					fail("invalid_snapshot");
				}
				const actions = [...current.actions];
				actions[index] = Object.freeze({ ...action, result });
				return {
					...current,
					actions: Object.freeze(actions),
					updatedAt: deps.now(),
				};
			});
		},
		async skipPending(command, lease, reasonCode) {
			if (!validReason(reasonCode)) fail("invalid_snapshot");
			return mutate(command, lease, (current) => ({
				...current,
				actions: Object.freeze(
					current.actions.map((entry) =>
						entry.state !== "pending"
							? entry
							: Object.freeze({
									...entry,
									state: "skipped" as const,
									result: Object.freeze({
										schemaVersion: 1 as const,
										index: entry.index,
										action: entry.action,
										status: "skipped" as const,
										reasonCode,
										affectedCount: 0,
									}),
								}),
					),
				),
				updatedAt: deps.now(),
			}));
		},
		async setFinalInboxObservation(command, lease, observation) {
			if (!validInboxObservation(observation)) fail("invalid_snapshot");
			return mutate(command, lease, (current) => ({
				...current,
				finalInboxObservation: clone(observation),
				updatedAt: deps.now(),
			}));
		},
		async finish(command, lease, status, reasonCode) {
			if (reasonCode !== undefined && !validReason(reasonCode)) {
				fail("invalid_snapshot");
			}
			return mutate(command, lease, (current) => {
				if (
					current.lifecycleIntent?.terminalStatus !== status ||
					current.lifecycleIntent.terminalReasonCode !== reasonCode
				) {
					fail("invalid_snapshot");
				}
				return {
					...current,
					terminalStatus: status,
					...(reasonCode === undefined
						? {}
						: { terminalReasonCode: reasonCode }),
					updatedAt: deps.now(),
				};
			});
		},
		async setDebriefStatus(command, lease, status) {
			const next = await mutate(command, lease, (current) => {
				if (current.terminalStatus === undefined) fail("invalid_snapshot");
				return {
					...current,
					debriefStatus: status,
					updatedAt: deps.now(),
				};
			});
			if (status === "available") await removeActive(command);
			else await ensureActive(command);
			return next;
		},
	});
}
