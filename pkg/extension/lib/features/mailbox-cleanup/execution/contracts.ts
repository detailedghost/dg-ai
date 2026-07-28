import type {
	MailboxCanonicalAction,
	MailboxReasonCode,
} from "@dg/common";
import type {
	MailboxProviderDispatchRequest,
	MailboxProviderDispatchResult,
	MailboxProviderFreshVerificationResult,
	MailboxProviderInboxObservation,
	MailboxProviderObserveRequest,
	MailboxProviderObserveResult,
	MailboxProviderOperationOptions,
	MailboxProviderPreflightRequest,
	MailboxProviderPreflightResult,
} from "../providers";

export { MAILBOX_EXECUTION_ACTION_TYPES } from "@dg/common";
export type { MailboxExecutionActionType } from "@dg/common";

export type MailboxExecutionCommand = Readonly<{
	planAlias: string;
	revisionAlias: string;
}>;

export type CanonicalMailboxExecutionAction = MailboxCanonicalAction;

export type CanonicalMailboxExecutionRevision = Readonly<{
	schemaVersion: 1;
	planAlias: string;
	revisionAlias: string;
	revisionNumber: number;
	state: "approved" | "in_flight" | "completed" | "canceled";
	restartRequired: boolean;
	createdAt: string;
	inventoryFingerprint: Readonly<{
		schemaVersion: 1;
		algorithm: "sha256";
		digest: string;
	}>;
	targets: Readonly<{
		folderAliases: readonly string[];
		labelAliases: readonly string[];
		filterAliases: readonly string[];
	}>;
	actions: readonly CanonicalMailboxExecutionAction[];
	cohorts: readonly unknown[];
}>;

export type MailboxExecutionActionState =
	| "pending"
	| "dispatched"
	| "observed"
	| "verified"
	| "needs_review"
	| "skipped";

export type MailboxExecutionAuthorityScope = Readonly<{
	schemaVersion: 1;
	actionAliases: readonly string[];
	targets: Readonly<{
		folderAliases: readonly string[];
		labelAliases: readonly string[];
		filterAliases: readonly string[];
	}>;
}>;

export type MailboxExecutionObservation = Readonly<{
	status: "observed";
	observedAt: string;
}>;

export type MailboxExecutionVerification = Readonly<{
	status: "verified";
	verifiedAt: string;
	delta: Readonly<{
		schemaVersion: 1;
		scope: "entire_fingerprint";
		actionAlias: string;
		changedAliases: readonly string[];
		beforeFingerprint: Readonly<{
			schemaVersion: 1;
			algorithm: "sha256";
			digest: string;
		}>;
		afterFingerprint: Readonly<{
			schemaVersion: 1;
			algorithm: "sha256";
			digest: string;
		}>;
		beforeScope: MailboxExecutionAuthorityScope;
		afterScope: MailboxExecutionAuthorityScope;
	}>;
}>;

export type MailboxExecutionInboxObservation = Readonly<{
	status: "observed";
	count: number;
	observedAt: string;
}>;

export type MailboxExecutionActionResult = Readonly<{
	schemaVersion: 1;
	index: number;
	action: CanonicalMailboxExecutionAction;
	status: "completed" | "skipped" | "needs_review" | "failed";
	reasonCode?: MailboxReasonCode;
	affectedCount: number;
}>;

export type MailboxExecutionActionJournal = Readonly<{
	index: number;
	action: CanonicalMailboxExecutionAction;
	state: MailboxExecutionActionState;
	observation?: MailboxExecutionObservation;
	verification?: MailboxExecutionVerification;
	result?: MailboxExecutionActionResult;
}>;

export type MailboxExecutionTerminalStatus =
	| "completed"
	| "failed"
	| "canceled";

export type MailboxExecutionLifecycleState =
	| "approved"
	| "in_flight"
	| "completed"
	| "canceled";

export type MailboxExecutionLease = Readonly<{
	owner: string;
	fence: number;
	expiresAt: string;
}>;

export type MailboxExecutionJournalSnapshot = Readonly<{
	schemaVersion: 1;
	planAlias: string;
	revisionAlias: string;
	accountAlias: string;
	revision: CanonicalMailboxExecutionRevision;
	authorityFingerprint: Readonly<{
		schemaVersion: 1;
		algorithm: "sha256";
		digest: string;
	}>;
	authorityScope: MailboxExecutionAuthorityScope;
	order: readonly number[];
	unitSize: 100;
	units: readonly Readonly<{
		startIndex: number;
		endIndex: number;
		state: "pending" | "in_flight" | "verified";
	}>[];
	actions: readonly MailboxExecutionActionJournal[];
	cancelRequested: boolean;
	lifecycleState: MailboxExecutionLifecycleState;
	lifecycleIntent?: Readonly<{
		expected: "approved" | "in_flight";
		next: "in_flight" | "completed" | "canceled";
		createdAt: string;
		terminalStatus?: MailboxExecutionTerminalStatus;
		terminalReasonCode?: MailboxReasonCode;
	}>;
	lease?: MailboxExecutionLease;
	nextFence: number;
	terminalStatus?: MailboxExecutionTerminalStatus;
	terminalReasonCode?: MailboxReasonCode;
	finalInboxObservation?: MailboxExecutionInboxObservation;
	debriefStatus: "pending" | "available" | "failed";
	updatedAt: string;
}>;

export type MailboxExecutionResult = Readonly<{
	status: "completed" | "paused" | "failed" | "canceled";
	reasonCode?: MailboxReasonCode;
	resumable: boolean;
	debriefAvailable?: boolean;
}>;

export type MailboxExecutionAtomicRecord = Readonly<{
	version: number;
	value: unknown;
}>;

export type MailboxExecutionAtomicStorage = Readonly<{
	read(key: string): Promise<MailboxExecutionAtomicRecord | undefined>;
	compareAndSet(
		key: string,
		expectedVersion: number | undefined,
		value: unknown,
	): Promise<boolean>;
}>;

export class MailboxExecutionJournalError extends Error {
	override readonly name = "MailboxExecutionJournalError";

	constructor(
		readonly code:
			| "storage_failure"
			| "invalid_snapshot"
			| "lease_unavailable"
			| "lease_lost"
			| "conflict",
	) {
		super(`Mailbox execution journal failed safely: ${code}`);
	}
}

export type MailboxExecutionJournal = Readonly<{
	heartbeatIntervalMs: number;
	activeCommands(): Promise<readonly MailboxExecutionCommand[]>;
	snapshot(
		command: MailboxExecutionCommand,
	): Promise<MailboxExecutionJournalSnapshot | undefined>;
	initialize(
		command: MailboxExecutionCommand,
		input: Readonly<{
			accountAlias: string;
			revision: CanonicalMailboxExecutionRevision;
			order: readonly number[];
		}>,
	): Promise<MailboxExecutionJournalSnapshot>;
	acquireLease(
		command: MailboxExecutionCommand,
		accountAlias: string,
		owner: string,
	): Promise<MailboxExecutionLease | undefined>;
	heartbeat(
		command: MailboxExecutionCommand,
		lease: MailboxExecutionLease,
	): Promise<MailboxExecutionLease>;
	releaseLease(
		command: MailboxExecutionCommand,
		lease: MailboxExecutionLease,
	): Promise<void>;
	requestCancel(command: MailboxExecutionCommand): Promise<boolean>;
	prepareLifecycle(
		command: MailboxExecutionCommand,
		lease: MailboxExecutionLease,
		expected: "approved" | "in_flight",
		next: "in_flight" | "completed" | "canceled",
		terminal?: Readonly<{
			status: MailboxExecutionTerminalStatus;
			reasonCode?: MailboxReasonCode;
		}>,
	): Promise<MailboxExecutionJournalSnapshot>;
	commitLifecycle(
		command: MailboxExecutionCommand,
		lease: MailboxExecutionLease,
		expected: "approved" | "in_flight",
		next: "in_flight" | "completed" | "canceled",
	): Promise<MailboxExecutionJournalSnapshot>;
	transitionAction(
		command: MailboxExecutionCommand,
		lease: MailboxExecutionLease,
		index: number,
		expected: MailboxExecutionActionState,
		next: MailboxExecutionActionState,
		patch?: Readonly<{
			observation?: MailboxExecutionObservation;
			verification?: MailboxExecutionVerification;
			result?: MailboxExecutionActionResult;
			authorityFingerprint?: MailboxExecutionJournalSnapshot["authorityFingerprint"];
			authorityScope?: MailboxExecutionAuthorityScope;
		}>,
	): Promise<MailboxExecutionJournalSnapshot>;
	setActionResult(
		command: MailboxExecutionCommand,
		lease: MailboxExecutionLease,
		index: number,
		result: MailboxExecutionActionResult,
	): Promise<MailboxExecutionJournalSnapshot>;
	skipPending(
		command: MailboxExecutionCommand,
		lease: MailboxExecutionLease,
		reasonCode: MailboxReasonCode,
	): Promise<MailboxExecutionJournalSnapshot>;
	setFinalInboxObservation(
		command: MailboxExecutionCommand,
		lease: MailboxExecutionLease,
		observation: MailboxExecutionInboxObservation,
	): Promise<MailboxExecutionJournalSnapshot>;
	finish(
		command: MailboxExecutionCommand,
		lease: MailboxExecutionLease,
		status: MailboxExecutionTerminalStatus,
		reasonCode?: MailboxReasonCode,
	): Promise<MailboxExecutionJournalSnapshot>;
	setDebriefStatus(
		command: MailboxExecutionCommand,
		lease: MailboxExecutionLease,
		status: "pending" | "available" | "failed",
	): Promise<MailboxExecutionJournalSnapshot>;
}>;

export type MailboxExecutionProvider = Readonly<{
	preflight(
		request: MailboxProviderPreflightRequest,
		options: MailboxProviderOperationOptions,
	): Promise<MailboxProviderPreflightResult>;
	dispatch(
		request: MailboxProviderDispatchRequest,
		options: MailboxProviderOperationOptions,
	): Promise<MailboxProviderDispatchResult>;
	observe(
		request: MailboxProviderObserveRequest,
		options: MailboxProviderOperationOptions,
	): Promise<MailboxProviderObserveResult>;
	verifyFresh(
		request: MailboxProviderObserveRequest,
		options: MailboxProviderOperationOptions,
	): Promise<MailboxProviderFreshVerificationResult>;
	observeInbox(
		request: Omit<
			MailboxProviderPreflightRequest,
			"actions" | "rawTargets"
		>,
		options: MailboxProviderOperationOptions,
	): Promise<MailboxProviderInboxObservation>;
}>;

export type MailboxExecutionCoordinator = Readonly<{
	start(command: MailboxExecutionCommand): Promise<MailboxExecutionResult>;
	resume(command: MailboxExecutionCommand): Promise<MailboxExecutionResult>;
	cancel(command: MailboxExecutionCommand): Promise<MailboxExecutionResult>;
	status(command: MailboxExecutionCommand): Promise<MailboxExecutionResult>;
	recoverActive(): Promise<readonly Readonly<{
		command: MailboxExecutionCommand;
		result: MailboxExecutionResult;
	}>[]>;
}>;
