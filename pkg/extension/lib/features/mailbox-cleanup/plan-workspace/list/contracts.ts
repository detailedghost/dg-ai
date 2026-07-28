import type {
	MailboxFingerprint,
	MailboxPlanRevision,
	MailboxRevisionState,
} from "@dg/common";
import type {
	MailboxLifecycle,
	MailboxLifecyclePlan,
} from "../../lifecycle";
import type {
	MailboxPlanStore,
	RawBindingScope,
	RawBindingStatus,
	RawBindingStore,
} from "../../storage";

export const MAILBOX_PLAN_LIST_STATES = [
	"draft",
	"approved",
	"in_flight",
	"completed",
] as const;

export type MailboxPlanListState =
	(typeof MAILBOX_PLAN_LIST_STATES)[number];

export const MAILBOX_PLAN_STALE_REASONS = [
	"none",
	"check_required",
	"restart_required",
	"missing_session",
	"interrupted_restart",
	"fingerprint_mismatch",
	"account_mismatch",
	"layout_mismatch",
	"preflight_failed",
	"storage_failure",
] as const;

export type MailboxPlanStaleReason =
	(typeof MAILBOX_PLAN_STALE_REASONS)[number];

export type MailboxPlanNextAction =
	| Readonly<{ type: "edit" }>
	| Readonly<{ type: "preflight" }>
	| Readonly<{ type: "focus" }>
	| Readonly<{ type: "resume" }>
	| Readonly<{ type: "restart" }>
	| Readonly<{ type: "view" }>;

export type MailboxPlanListRow = Readonly<{
	schemaVersion: 1;
	planAlias: string;
	revisionAlias: string;
	providerId: string;
	surface: string;
	accountAlias: string | null;
	lifecycleState: MailboxPlanListState;
	stale: boolean;
	staleReason: MailboxPlanStaleReason;
	updatedAt: string;
	expiresAt: string;
	nextAction: MailboxPlanNextAction;
}>;

export type MailboxPlanListQuery = Readonly<{
	states?: readonly MailboxPlanListState[];
	stale?: "all" | "only" | "exclude";
	providerId?: string;
	surface?: string;
	accountAlias?: string;
}>;

export type MailboxPlanListResult = Readonly<{
	schemaVersion: 1;
	rows: readonly MailboxPlanListRow[];
}>;

export type MailboxPlanListCommandType =
	| "edit"
	| "preflight"
	| "focus"
	| "resume"
	| "restart";

export type MailboxPlanListCommand = Readonly<{
	schemaVersion: 1;
	type: MailboxPlanListCommandType;
	planAlias: string;
	revisionAlias: string;
	requestAlias: string;
}>;

export type MailboxPlanListActionResult =
	| Readonly<{
			schemaVersion: 1;
			status: "completed";
			requestAlias: string;
			action: MailboxPlanListCommandType;
			planAlias: string;
			revisionAlias: string;
			lifecycleState: MailboxPlanListState;
			preservedApproval: boolean;
	  }>
	| Readonly<{
			schemaVersion: 1;
			status: "blocked";
			requestAlias: string;
			action: MailboxPlanListCommandType;
			reason: Exclude<MailboxPlanStaleReason, "none" | "check_required">;
	  }>
	| Readonly<{
			schemaVersion: 1;
			status: "canceled";
			requestAlias: string;
			action: MailboxPlanListCommandType;
	  }>;

export type MailboxPlanRestartRecoveryResult = Readonly<{
	schemaVersion: 1;
	planAlias: string;
	revisionAlias: string;
	status: "recovered" | "blocked";
	candidateRevisionAlias?: string;
}>;

export type MailboxPlanBindingContext = Readonly<{
	schemaVersion: 1;
	planAlias: string;
	revisionAlias: string;
	providerId: string;
	surface: string;
	accountAlias: string;
	runAlias: string;
}>;

export type MailboxPlanRestartCheckpoint = Readonly<{
	actionAlias: string;
	state: "verified" | "needs_review" | "skipped" | "pending";
}>;

export type MailboxPlanRestartAuthority = Readonly<{
	fingerprint: MailboxFingerprint;
	scope: Readonly<{
		schemaVersion: 1;
		actionAliases: readonly string[];
		targets: Readonly<{
			folderAliases: readonly string[];
			labelAliases: readonly string[];
			filterAliases: readonly string[];
		}>;
	}>;
}>;

export type MailboxPlanRestartCapture = Readonly<{
	schemaVersion: 1;
	comparisonFingerprint?: MailboxFingerprint;
	revision: MailboxPlanRevision;
	context: MailboxPlanBindingContext;
	bindings: Readonly<Record<string, string>>;
	priorToFreshAliases?: Readonly<Record<string, string>>;
	proof: Readonly<{
		sameAccount: boolean;
		locale: "en-US";
		layout: "supported" | "unsupported";
		preflight: "ready" | "blocked";
	}>;
}>;

export type MailboxPlanListAtomicRecord = Readonly<{
	version: number;
	value: unknown;
}>;

export type MailboxPlanListAtomicStorage = Readonly<{
	read(key: string): Promise<MailboxPlanListAtomicRecord | undefined>;
	compareAndSet(
		key: string,
		expectedVersion: number | undefined,
		value: unknown,
	): Promise<boolean>;
}>;

export type MailboxPlanListExecutionSeam = Readonly<{
	status(
		planAlias: string,
		revisionAlias: string,
	): Promise<"live" | "resumable" | "missing">;
	fenceRestart?(
		planAlias: string,
		revisionAlias: string,
		signal?: AbortSignal,
	): Promise<void>;
	focus(planAlias: string, revisionAlias: string): Promise<void>;
	resume(
		planAlias: string,
		revisionAlias: string,
		signal?: AbortSignal,
	): Promise<
		| void
		| "completed"
		| Exclude<MailboxPlanStaleReason, "none" | "check_required">
	>;
	checkpoints(
		planAlias: string,
		revisionAlias: string,
	): Promise<readonly MailboxPlanRestartCheckpoint[]>;
	restartAuthority?(
		planAlias: string,
		revisionAlias: string,
	): Promise<MailboxPlanRestartAuthority>;
	prepareRestart(input: Readonly<{
		sourcePlanAlias: string;
		sourceRevisionAlias: string;
		revision: MailboxPlanRevision;
		checkpoints: readonly MailboxPlanRestartCheckpoint[];
		priorToFreshAliases?: Readonly<Record<string, string>>;
	}>): Promise<void>;
}>;

export type MailboxPlanListNavigationSeam = Readonly<{
	edit(planAlias: string, revisionAlias: string): Promise<void>;
	preflight(
		planAlias: string,
		revisionAlias: string,
	): Promise<
		| "ready"
		| "blocked"
		| Readonly<{ status: "ready"; fingerprintMatches: true }>
		| Readonly<{
				status: "blocked";
				reason:
					| "fingerprint_mismatch"
					| "account_mismatch"
					| "layout_mismatch"
					| "preflight_failed";
		  }>
	>;
}>;

export type MailboxPlanListServiceDeps = Readonly<{
	store: Pick<
		MailboxPlanStore,
		"getRecord" | "putRevision" | "listPlans"
	>;
	lifecycle: Pick<MailboxLifecycle, "reconcileAll" | "transition">;
	bindings: Pick<
		RawBindingStore,
		"get" | "put" | "status" | "invalidateRevision" | "invalidate"
	>;
	storage: MailboxPlanListAtomicStorage;
	execution: MailboxPlanListExecutionSeam;
	navigation: MailboxPlanListNavigationSeam;
	rescan(input: Readonly<{
		sourceRevision: MailboxPlanRevision;
		sourceContext: MailboxPlanBindingContext;
		previousBindings?: Readonly<Record<string, string>>;
		checkpoints: readonly MailboxPlanRestartCheckpoint[];
		comparisonAuthority?: MailboxPlanRestartAuthority;
		signal: AbortSignal;
	}>): Promise<MailboxPlanRestartCapture>;
	now(): number;
	randomBytes?(size: number): Uint8Array;
	restartTimeoutMs?: number;
}>;

export type MailboxPlanListService = Readonly<{
	register(
		revision: MailboxPlanRevision,
		context: MailboxPlanBindingContext,
	): Promise<void>;
	list(query?: MailboxPlanListQuery): Promise<MailboxPlanListResult>;
	perform(
		command: MailboxPlanListCommand,
		options?: Readonly<{ signal?: AbortSignal }>,
	): Promise<MailboxPlanListActionResult>;
	recoverRestarts(): Promise<readonly MailboxPlanRestartRecoveryResult[]>;
	hasActiveRestart(planAlias: string, revisionAlias: string): Promise<boolean>;
	acquireExecutionAdmission(
		planAlias: string,
		revisionAlias: string,
		owner: string,
	): Promise<void>;
	assertExecutionAdmission(
		planAlias: string,
		revisionAlias: string,
		owner: string,
	): Promise<void>;
	releaseExecutionAdmission(
		planAlias: string,
		revisionAlias: string,
		owner: string,
	): Promise<void>;
	waitForExecutionDrain(
		planAlias: string,
		revisionAlias: string,
		signal?: AbortSignal,
	): Promise<void>;
}>;

export type MailboxPlanListLifecycleSnapshot = Readonly<{
	plan: MailboxLifecyclePlan;
	state: MailboxRevisionState;
	status: RawBindingStatus;
}>;
