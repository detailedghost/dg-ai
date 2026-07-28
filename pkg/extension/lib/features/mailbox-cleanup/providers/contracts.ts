import type {
	MailboxAction,
	MailboxActionResult,
	MailboxCanonicalAction,
	MailboxExecutionActionType,
	MailboxProviderObservation,
	MailboxReasonCode,
} from "@dg/common";
import type { RawMailboxInventory } from "../privacy";
import type {
	MailboxCaptureRequest,
	MailboxCoordinatorProviderSeams,
} from "../coordinator";

export type MailboxProviderSurface = string;

export type MailboxProviderScope = Readonly<{
	providerId: string;
	surface: MailboxProviderSurface;
	accountAlias: string;
	runAlias: string;
	revisionAlias: string;
}>;

export type MailboxProviderCaptureRequest = MailboxProviderScope;

export type MailboxProviderMutationRequest = MailboxProviderScope &
	Readonly<{
		action: MailboxAction;
		rawTarget: string;
	}>;

export type MailboxProviderVerificationRequest = MailboxProviderScope &
	Readonly<{
		action: MailboxAction;
		rawTarget: string;
	}>;

export type MailboxProviderRawTargets = Readonly<Record<string, string>>;

export type MailboxProviderPreflightRequest = MailboxProviderScope &
	Readonly<{
		actions: readonly MailboxCanonicalAction[];
		rawTargets: MailboxProviderRawTargets;
	}>;

export type MailboxProviderDispatchRequest = MailboxProviderScope &
	Readonly<{
		action: MailboxCanonicalAction;
		rawTargets: MailboxProviderRawTargets;
	}>;

export type MailboxProviderObserveRequest = MailboxProviderDispatchRequest;

export const MAILBOX_PROVIDER_PROMPTS = [
	"login",
	"mfa",
	"captcha",
	"consent",
	"conditional_access",
] as const;

export type MailboxProviderPrompt =
	(typeof MAILBOX_PROVIDER_PROMPTS)[number];

export type MailboxProviderPreflightResult =
	| Readonly<{
			status: "ready";
			providerId: string;
			surface: MailboxProviderSurface;
			accountAlias: string;
			locale: string;
			layout: "supported";
			capabilities: readonly MailboxExecutionActionType[];
			targets: "available";
	  }>
	| Readonly<{
			status: "blocked";
			reasonCode: MailboxReasonCode;
			prompt?: MailboxProviderPrompt;
	  }>;

export type MailboxProviderDispatchResult = Readonly<{
	status: "dispatched";
}>;

export type MailboxProviderObserveResult =
	| Readonly<{ status: "observed"; observedAt: string }>
	| Readonly<{
			status: "ambiguous";
			reasonCode: MailboxReasonCode;
	  }>;

/**
 * Exhaustive alias delta from whole fingerprint-scope observations taken
 * immediately before and after one action. Adapters must return ambiguous when
 * either observation is unavailable, including after an unreconciled restart.
 */
export type MailboxProviderActionDelta = Readonly<{
	schemaVersion: 1;
	scope: "entire_fingerprint";
	actionAlias: string;
	changedAliases: readonly string[];
}>;

export type MailboxProviderFreshVerificationResult =
	| Readonly<{
			status: "verified";
			verifiedAt: string;
			delta: MailboxProviderActionDelta;
	  }>
	| Readonly<{
			status: "mismatch" | "ambiguous" | "timeout";
			reasonCode: MailboxReasonCode;
	  }>;

export type MailboxProviderInboxObservation =
	| Readonly<{
			status: "observed";
			count: number;
			observedAt: string;
	  }>
	| Readonly<{
			status: "ambiguous" | "timeout";
			reasonCode: MailboxReasonCode;
	  }>;

export type MailboxProviderOperationOptions = Readonly<{
	signal?: AbortSignal;
	timeoutMs?: number;
}>;

export type MailboxProviderCoordinatorSeams =
	MailboxCoordinatorProviderSeams &
		Readonly<{
			bindings(
				request: Omit<
					MailboxCaptureRequest,
					"bodyMessageAliases" | "schemaVersion"
				>,
				signal: AbortSignal,
			): Promise<Readonly<Record<string, string>>>;
		}>;

/**
 * Frozen extension point for browser-visible mail providers. Implementations
 * operate on the signed-in page only; the contract has no URL, token, request,
 * script, command, selector, or remote-provider escape hatch.
 */
export type MailboxProvider = Readonly<{
	id: string;
	surfaces: readonly MailboxProviderSurface[];
	coordinator: MailboxProviderCoordinatorSeams;
	readLocale(): string | readonly string[] | Promise<string | readonly string[]>;
	hasPositiveLayoutSignature(
		surface: MailboxProviderSurface,
	): boolean | Promise<boolean>;
	capture(
		request: MailboxProviderCaptureRequest,
	): RawMailboxInventory | Promise<RawMailboxInventory>;
	apply(
		request: MailboxProviderMutationRequest,
	): MailboxProviderObservation | Promise<MailboxProviderObservation>;
	verify(
		request: MailboxProviderVerificationRequest,
	): MailboxActionResult | Promise<MailboxActionResult>;
	preflight?(
		request: MailboxProviderPreflightRequest,
		options?: MailboxProviderOperationOptions,
	): MailboxProviderPreflightResult | Promise<MailboxProviderPreflightResult>;
	dispatch?(
		request: MailboxProviderDispatchRequest,
		options?: MailboxProviderOperationOptions,
	): MailboxProviderDispatchResult | Promise<MailboxProviderDispatchResult>;
	observe?(
		request: MailboxProviderObserveRequest,
		options?: MailboxProviderOperationOptions,
	): MailboxProviderObserveResult | Promise<MailboxProviderObserveResult>;
	verifyFresh?(
		request: MailboxProviderObserveRequest,
		options?: MailboxProviderOperationOptions,
	): MailboxProviderFreshVerificationResult | Promise<MailboxProviderFreshVerificationResult>;
	observeInbox?(
		request: MailboxProviderCaptureRequest,
		options?: MailboxProviderOperationOptions,
	): MailboxProviderInboxObservation | Promise<MailboxProviderInboxObservation>;
}>;

export type MailboxExecutionProvider = MailboxProvider &
	Readonly<
		Required<
			Pick<
				MailboxProvider,
				| "preflight"
				| "dispatch"
				| "observe"
				| "verifyFresh"
				| "observeInbox"
			>
		>
	>;

export type GuardedMailboxProvider = Readonly<{
	id: string;
	surfaces: readonly MailboxProviderSurface[];
	capture(request: MailboxProviderCaptureRequest): Promise<RawMailboxInventory>;
	apply(
		request: MailboxProviderMutationRequest,
	): Promise<MailboxProviderObservation>;
	verify(
		request: MailboxProviderVerificationRequest,
	): Promise<MailboxActionResult>;
}>;

/**
 * Coordinator-facing execution facade. Raw provider implementations are bound
 * once, then every request and response crosses the strict guarded boundary.
 */
export type GuardedMailboxExecutionProvider = Readonly<{
	preflight(
		request: MailboxProviderPreflightRequest,
		options?: MailboxProviderOperationOptions,
	): Promise<MailboxProviderPreflightResult>;
	dispatch(
		request: MailboxProviderDispatchRequest,
		options?: MailboxProviderOperationOptions,
	): Promise<MailboxProviderDispatchResult>;
	observe(
		request: MailboxProviderObserveRequest,
		options?: MailboxProviderOperationOptions,
	): Promise<MailboxProviderObserveResult>;
	verifyFresh(
		request: MailboxProviderObserveRequest,
		options?: MailboxProviderOperationOptions,
	): Promise<MailboxProviderFreshVerificationResult>;
	observeInbox(
		request: MailboxProviderCaptureRequest,
		options?: MailboxProviderOperationOptions,
	): Promise<MailboxProviderInboxObservation>;
}>;

export const MAILBOX_PROVIDER_CONTRACT_VERSION = 1 as const;

export type MailboxProviderModule = Readonly<{
	default: MailboxProvider;
}>;
