import type {
	MailboxAction,
	MailboxCohort,
	MailboxPlanRevision,
	MailboxRevisionTargets,
	MailboxValidatedHint,
} from "@dg/common";
import type {
	MailboxCaptureCounts,
	MailboxCaptureResult,
} from "../coordinator";
import type { MailboxChatSubmitResult } from "../bridge";
import type { MailboxLifecycle } from "../lifecycle";
import type { MailboxScopedFingerprintInput } from "../planning";
import type {
	RawBindingScope,
	RawBindingStore,
} from "../storage";

export type SuccessfulMailboxCapture = Extract<
	MailboxCaptureResult,
	{ status: "complete" | "partial" }
>;

export type MailboxPlanWorkspaceInput = Readonly<{
	capture: SuccessfulMailboxCapture;
	baseRevision: MailboxPlanRevision;
	bindingScope: RawBindingScope;
	bindingExpiresAt: number;
	planExpiresAt: number;
	localHints?: readonly MailboxValidatedHint[];
}>;

export type MailboxPlanChatSeam = Readonly<{
	submit(value: {
		inventory: SuccessfulMailboxCapture["inventory"];
		revision: MailboxPlanRevision;
	}): Promise<MailboxChatSubmitResult | Readonly<Record<string, unknown>>>;
	cancel?(): Promise<void>;
	reconnect?(): Promise<void>;
	isOpen(): boolean;
}>;

export type MailboxPlanWorkspaceDeps = Readonly<{
	lifecycle: Pick<MailboxLifecycle, "create" | "edit" | "transition">;
	rawBindings: Pick<RawBindingStore, "get" | "touch"> &
		Partial<Pick<RawBindingStore, "put" | "status">>;
	computeFingerprint(
		value: MailboxScopedFingerprintInput,
	): Promise<MailboxPlanRevision["inventoryFingerprint"]>;
	createRevisionAlias(): string;
	createActionAlias(): string;
	now(): number;
	bridge: MailboxPlanChatSeam;
	startExecution(command: Readonly<{
		planAlias: string;
		revisionAlias: string;
	}>): Promise<unknown>;
}>;

export type MailboxChoiceId =
	| "conservative"
	| "balanced"
	| "inbox_zero";

export type MailboxMessageEditAction =
	| "archive"
	| "mark_read"
	| "move_to_folder"
	| "apply_label"
	| "remove_label";

export type MailboxPlanEdit =
	| Readonly<{
			type: "set_cohort_action";
			cohortKey: string;
			action: "archive" | "mark_read" | "review";
	  }>
	| Readonly<{
			type: "set_message_exception";
			messageAlias: string;
			action: MailboxMessageEditAction;
			folderAlias?: string;
			labelAlias?: string;
	  }>
	| Readonly<{
			type: "set_message_action";
			messageAlias: string;
			action: MailboxMessageEditAction;
			selected: boolean;
			folderAlias?: string;
			labelAlias?: string;
	  }>
	| Readonly<{
			type: "exclude_message";
			messageAlias: string;
	  }>
	| Readonly<{
			type: "include_message";
			messageAlias: string;
	  }>
	| Readonly<{
			type: "set_bulk_exclusions";
			messageAliases: readonly string[];
	  }>
	| Readonly<{
			type: "set_filter_action";
			filterAlias: string;
			action: "deactivate_filter" | "review";
	  }>
	| Readonly<{
			type: "set_target";
			targetKind: "folder" | "label" | "filter";
			alias: string;
			selected: boolean;
	  }>
	| Readonly<{
			type: "apply_chat_proposal";
			proposal: MailboxPlanRevision;
	  }>;

export type MailboxChoiceOutcome = Readonly<{
	archived: number;
	markedRead: number;
	review: number;
	deleted: 0;
}>;

export type MailboxPlanSnapshot = Readonly<{
	captureCounts: MailboxCaptureCounts;
	cohorts: readonly MailboxCohort[];
	coverage: "complete" | "partial";
	uncapturedCount: "unknown" | 0;
	selectedChoiceId: MailboxChoiceId;
	sliderPosition: 0 | 50 | 100;
	actions: readonly MailboxAction[];
	targets: MailboxRevisionTargets;
	reviewMessageAliases: readonly string[];
	excludedMessageAliases: readonly string[];
	revision: MailboxPlanRevision;
	restartRequired: boolean;
	bindingAvailable: boolean;
	bindingExpiresAt: number;
	planExpiresAt: number;
	planExpired: boolean;
	transitionPending: boolean;
	chatAvailable: boolean;
	dirty: boolean;
	outcome: MailboxChoiceOutcome;
	announcement: string;
	operationStatus:
		| "idle"
		| "saving"
		| "submitting"
		| "accepting"
		| "canceling"
		| "editing"
		| "reconnecting";
	chatStatus:
		| "idle"
		| "waiting"
		| "reconnecting"
		| "disconnected"
		| "proposal"
		| "canceled"
		| "error";
	chatMessage: string;
	canReconnect: boolean;
	editorInventory: Readonly<{
		messageAliases: readonly string[];
		messages: readonly Readonly<{
			alias: string;
			category: string;
			receivedAt: string;
			read: boolean;
			hasAttachments: boolean;
		}>[];
		folderAliases: readonly string[];
		labelAliases: readonly string[];
		tagAliases: readonly string[];
		categoryAliases: readonly string[];
		filterAliases: readonly string[];
	}>;
}>;

export type MailboxPlanWorkspace = Readonly<{
	getSnapshot(): MailboxPlanSnapshot;
	subscribe(listener: (snapshot: MailboxPlanSnapshot) => void): () => void;
	selectChoice(choiceId: MailboxChoiceId): Promise<void>;
	applyEdit(edit: MailboxPlanEdit): Promise<void>;
	saveDraft(): Promise<MailboxPlanRevision>;
	submitToChat(): Promise<
		MailboxChatSubmitResult | Readonly<Record<string, unknown>>
	>;
	acceptRevision(): Promise<MailboxPlanRevision>;
	cancel(): Promise<void>;
	reconnectChat(): Promise<void>;
	refreshStatus(): Promise<void>;
}>;

export type MailboxPlanPageOptions = Readonly<{
	resolveDisplayText?(alias: string): string | undefined;
	clearDisplayText?(): void;
	scheduler?: Readonly<{
		setTimeout(callback: () => void, milliseconds: number): unknown;
		clearTimeout(timer: unknown): void;
	}>;
}>;
