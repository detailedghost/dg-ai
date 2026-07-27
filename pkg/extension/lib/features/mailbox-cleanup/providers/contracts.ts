import type {
	MailboxAction,
	MailboxActionResult,
	MailboxProviderObservation,
} from "@dg/common";
import type { RawMailboxInventory } from "../privacy";

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

/**
 * Frozen extension point for browser-visible mail providers. Implementations
 * operate on the signed-in page only; the contract has no URL, token, request,
 * script, command, selector, or remote-provider escape hatch.
 */
export type MailboxProvider = Readonly<{
	id: string;
	surfaces: readonly MailboxProviderSurface[];
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
}>;

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

export const MAILBOX_PROVIDER_CONTRACT_VERSION = 1 as const;

export type MailboxProviderModule = Readonly<{
	default: MailboxProvider;
}>;
