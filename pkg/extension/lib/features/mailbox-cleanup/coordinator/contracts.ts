import type {
	MailboxCohort,
	MailboxInventory,
	MailboxProviderObservation,
	MailboxReasonCode,
} from "@dg/common";

export type MailboxCaptureLimits = Readonly<{
	messages: number;
	folders: number;
	labels: number;
	tags: number;
	categories: number;
	filters: number;
	chunks: number;
	chunkItems: number;
	bufferedChunks: number;
	assembledInventoryItems: number;
	sanitizedTextCharacters: number;
	chatPayloadCharacters: number;
	bodyAliases: number;
	bodyUnicodeCharacters: number;
}>;

export const MAILBOX_CAPTURE_LIMITS = Object.freeze({
	messages: 5_000,
	folders: 500,
	labels: 1_000,
	tags: 1_000,
	categories: 256,
	filters: 500,
	chunks: 256,
	chunkItems: 250,
	bufferedChunks: 1,
	assembledInventoryItems: 9_000,
	sanitizedTextCharacters: 1_000_000,
	chatPayloadCharacters: 1_000_000,
	bodyAliases: 20,
	bodyUnicodeCharacters: 2_000,
}) satisfies MailboxCaptureLimits;

export const MAILBOX_CAPTURE_KINDS = [
	"messages",
	"folders",
	"labels",
	"tags",
	"categories",
	"filters",
] as const;

export type MailboxCaptureKind = (typeof MAILBOX_CAPTURE_KINDS)[number];

export type MailboxCaptureChunkPayload = Readonly<{
	kind: string;
	items: readonly unknown[];
}>;

export type MailboxCaptureChunkDigestInput = Readonly<{
	schemaVersion: number;
	runAlias: string;
	sequence: number;
	itemCount: number;
	payload: MailboxCaptureChunkPayload;
	declaredTotal?: number;
	final?: true;
}>;

type MailboxCaptureChunkBase = Readonly<{
	schemaVersion: number;
	runAlias: string;
	sequence: number;
	itemCount: number;
	digest: string;
	payload: MailboxCaptureChunkPayload;
}>;

export type MailboxCaptureChunk = MailboxCaptureChunkBase &
	Readonly<{
		declaredTotal?: number;
		final?: true;
	}>;

export type MailboxCaptureCounts = Readonly<
	Record<MailboxCaptureKind, number>
>;

export type MailboxCaptureMetadataItem = Readonly<{
	alias: string;
	messageCount?: number;
}>;

export type MailboxCaptureMetadata = Readonly<{
	tags: readonly MailboxCaptureMetadataItem[];
	categories: readonly MailboxCaptureMetadataItem[];
}>;

export type MailboxAssembledCapture = Readonly<{
	counts: MailboxCaptureCounts;
	messages: MailboxInventory["messages"];
	folders: MailboxInventory["folders"];
	labels: MailboxInventory["labels"];
	tags: readonly MailboxCaptureMetadataItem[];
	categories: readonly MailboxCaptureMetadataItem[];
	filters: MailboxInventory["filters"];
	messageAliases: ReadonlySet<string>;
}>;

export type MailboxCoordinatorState =
	| "idle"
	| "probing"
	| "binding_account"
	| "capturing_summary"
	| "capturing_metadata"
	| "awaiting_body_consent"
	| "checking_bodies"
	| "deriving_cohorts"
	| "complete"
	| "partial"
	| "canceled"
	| "refused"
	| "blocked_prompt"
	| "wrong_account"
	| "malformed_stream"
	| "worker_suspended";

export type MailboxCaptureProgress = Readonly<{
	state: MailboxCoordinatorState;
	counts?: MailboxCaptureCounts;
}>;

export type MailboxCaptureRequest = Readonly<{
	schemaVersion: 1;
	providerId: string;
	surface: string;
	accountAlias: string;
	runAlias: string;
	revisionAlias: string;
	bodyMessageAliases: readonly string[];
}>;

export type MailboxProviderProbeResult =
	| Readonly<{
			status: "ready";
			accountAlias: string;
			surface: string;
	  }>
	| Readonly<{
			status:
				| "signed_out"
				| "security_prompt"
				| "wrong_account"
				| "ambiguous_surface"
				| "worker_suspended"
				| "blocked_prompt";
			reasonCode?: MailboxReasonCode;
	  }>;

export type MailboxProviderCaptureResult =
	| Readonly<{ status: "complete" }>
	| Readonly<{
			status: "partial";
			reasonCode: "provider_partial";
	  }>;

export class MailboxCoordinatorProviderError extends Error {
	override readonly name = "MailboxCoordinatorProviderError";

	constructor(readonly reasonCode: MailboxReasonCode) {
		super(`Mailbox coordinator provider rejected: ${reasonCode}`);
	}
}

export type MailboxBodyReadRequest = Omit<
	MailboxCaptureRequest,
	"bodyMessageAliases" | "schemaVersion"
> &
	Readonly<{ messageAliases: readonly string[] }>;

export type RawMailboxBodyResult = Readonly<{
	messageAlias: string;
	text: string;
	attachments?: unknown;
	quotedHistory?: unknown;
}>;

export type MailboxBodyCheckResult = Readonly<{
	messageAlias: string;
	text: string;
	characterCount: number;
}>;

export type MailboxBodyChecks = Readonly<{
	results: readonly MailboxBodyCheckResult[];
}>;

export type MailboxBodyCheckConsentRequest = Readonly<{
	runAlias: string;
	messageAliases: readonly string[];
}>;

export type MailboxBodyCheckConsent = Readonly<{
	granted: boolean;
	runAlias: string;
	messageAliases: readonly string[];
}>;

export type MailboxCoordinatorProviderSeams = Readonly<{
	probe(
		request: Omit<MailboxCaptureRequest, "bodyMessageAliases" | "schemaVersion">,
		signal: AbortSignal,
	): Promise<MailboxProviderProbeResult>;
	capture(
		request: Omit<MailboxCaptureRequest, "bodyMessageAliases" | "schemaVersion">,
		signal: AbortSignal,
	): AsyncIterable<MailboxCaptureChunk>;
	readBodies(
		request: MailboxBodyReadRequest,
		signal: AbortSignal,
	): Promise<readonly RawMailboxBodyResult[]>;
	observe?(
		request: MailboxBodyReadRequest,
		signal: AbortSignal,
	): Promise<MailboxProviderObservation>;
	captureResult(
		request: Omit<
			MailboxCaptureRequest,
			"bodyMessageAliases" | "schemaVersion"
		>,
		signal: AbortSignal,
	): Promise<MailboxProviderCaptureResult>;
}>;

export type MailboxCleanupChoiceSummary = Readonly<{
	id: "conservative" | "balanced" | "inbox_zero";
	sliderPosition: 0 | 50 | 100;
	actions: readonly import("@dg/common").MailboxAction[];
	reviewMessageAliases: readonly string[];
	promisesInboxZero: boolean;
	partial: boolean;
	metadata: Readonly<{
		tagAliases: readonly string[];
		categoryAliases: readonly string[];
	}>;
}>;

type SuccessfulCaptureResult = Readonly<{
	status: "complete" | "partial";
	reasonCode?: "provider_partial";
	inventory: MailboxInventory;
	counts: MailboxCaptureCounts;
	metadata: MailboxCaptureMetadata;
	cohorts: readonly MailboxCohort[];
	choices: readonly MailboxCleanupChoiceSummary[];
	bodyChecks?: MailboxBodyChecks;
}>;

type FailedCaptureStatus = Exclude<
	MailboxCoordinatorState,
	| "idle"
	| "probing"
	| "binding_account"
	| "capturing_summary"
	| "capturing_metadata"
	| "awaiting_body_consent"
	| "checking_bodies"
	| "deriving_cohorts"
	| "complete"
	| "partial"
>;

export type MailboxCaptureResult =
	| SuccessfulCaptureResult
	| Readonly<{
			status: FailedCaptureStatus;
			reasonCode: MailboxReasonCode;
	  }>;

export type MailboxCaptureCoordinatorDeps = Readonly<{
	provider: MailboxCoordinatorProviderSeams;
	now: () => string;
	requestBodyConsent?: (
		request: MailboxBodyCheckConsentRequest,
	) => Promise<MailboxBodyCheckConsent>;
	onProgress?: (progress: MailboxCaptureProgress) => void;
	limits?: MailboxCaptureLimits;
}>;

export type MailboxCaptureCoordinator = Readonly<{
	start(request: MailboxCaptureRequest): Promise<MailboxCaptureResult>;
	cancel(): void;
	suspend(): void;
	getState(): MailboxCoordinatorState;
}>;
