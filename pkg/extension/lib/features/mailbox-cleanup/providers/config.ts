import {
	type MailboxAction,
	type MailboxActionResult,
	type MailboxProviderObservation,
	preflightMailboxValue,
	serializeMailboxAction,
	validateMailboxAction,
	validateMailboxActionResult,
	validateMailboxProviderObservation,
} from "@dg/common";
import { isValidMailboxScopedAlias } from "../privacy/aliases";
import type {
	MailboxProvider,
	MailboxProviderCaptureRequest,
	MailboxProviderMutationRequest,
	MailboxProviderVerificationRequest,
} from "./contracts";

export const MAILBOX_PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{1,62}$/;
const SURFACE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const PROVIDER_SCOPE_KEYS = [
	"providerId",
	"surface",
	"accountAlias",
	"runAlias",
	"revisionAlias",
] as const;
const CAPTURE_REQUEST_KEYS = PROVIDER_SCOPE_KEYS;
const MUTATION_REQUEST_KEYS = [
	...PROVIDER_SCOPE_KEYS,
	"action",
	"rawTarget",
] as const;
const PROVIDER_KEYS = [
	"id",
	"surfaces",
	"readLocale",
	"hasPositiveLayoutSignature",
	"capture",
	"apply",
	"verify",
] as const;

export class MailboxProviderConfigurationError extends Error {
	override readonly name = "MailboxProviderConfigurationError";

	constructor(
		readonly code:
			| "provider_shape"
			| "provider_id"
			| "provider_surface"
				| "provider_locale"
				| "layout_signature"
				| "action_mismatch"
				| "provider_failure",
	) {
		super(`Mailbox provider rejected: ${code}`);
	}
}

function fail(
	code: ConstructorParameters<typeof MailboxProviderConfigurationError>[0],
): never {
	throw new MailboxProviderConfigurationError(code);
}

function dataObject(value: unknown): Record<string, unknown> {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype
	) {
		fail("provider_shape");
	}
	const keys = Reflect.ownKeys(value);
	if (keys.some((key) => typeof key === "symbol")) fail("provider_shape");
	for (const key of keys as string[]) {
		if (
			key === "__proto__" ||
			key === "constructor" ||
			key === "prototype"
		) {
			fail("provider_shape");
		}
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || "get" in descriptor || "set" in descriptor) {
			fail("provider_shape");
		}
	}
	return value as Record<string, unknown>;
}

function requestObject(value: unknown): Record<string, unknown> {
	preflightMailboxValue(value);
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value)
	) {
		fail("provider_shape");
	}
	return value as Record<string, unknown>;
}

function exactRequestKeys(
	request: Record<string, unknown>,
	expected: readonly string[],
): void {
	const keys = Object.keys(request);
	if (
		keys.length !== expected.length ||
		!expected.every((key) => Object.hasOwn(request, key))
	) {
		fail("provider_shape");
	}
}

function matchingString(value: unknown, pattern: RegExp): string {
	if (typeof value !== "string" || !pattern.test(value)) {
		fail("provider_shape");
	}
	return value;
}

function matchingAlias(value: unknown, prefix: string): string {
	if (!isValidMailboxScopedAlias(value, prefix)) {
		fail("provider_shape");
	}
	return value;
}

function providerScope(
	request: Record<string, unknown>,
): MailboxProviderCaptureRequest {
	return {
		providerId: matchingString(
			request.providerId,
			MAILBOX_PROVIDER_ID_PATTERN,
		),
		surface: matchingString(request.surface, SURFACE_PATTERN),
		accountAlias: matchingAlias(request.accountAlias, "acct"),
		runAlias: matchingAlias(request.runAlias, "run"),
		revisionAlias: matchingAlias(request.revisionAlias, "rev"),
	};
}

function validateCaptureRequest(
	value: unknown,
): MailboxProviderCaptureRequest {
	const request = requestObject(value);
	exactRequestKeys(request, CAPTURE_REQUEST_KEYS);
	return providerScope(request);
}

function validateMutationRequest(
	value: unknown,
): MailboxProviderMutationRequest {
	const request = requestObject(value);
	exactRequestKeys(request, MUTATION_REQUEST_KEYS);
	if (
		typeof request.rawTarget !== "string" ||
		request.rawTarget.length === 0 ||
		request.rawTarget.length > 4096
	) {
		fail("provider_shape");
	}
	return {
		...providerScope(request),
		action: validateMailboxAction(request.action),
		rawTarget: request.rawTarget,
	};
}

function validateVerificationRequest(
	value: unknown,
): MailboxProviderVerificationRequest {
	return validateMutationRequest(value);
}

function actionsMatch(left: MailboxAction, right: MailboxAction): boolean {
	return (
		serializeMailboxAction(left) === serializeMailboxAction(right)
	);
}

/** Return a canonical English BCP-47 locale, or undefined when unsupported. */
export function normalizeEnglishLocale(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0 || value.length > 64) {
		return undefined;
	}
	const candidate = value.trim().replaceAll("_", "-");
	if (!/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(candidate)) {
		return undefined;
	}
	try {
		const canonical = Intl.getCanonicalLocales(candidate)[0];
		if (!canonical || canonical.split("-")[0]?.toLowerCase() !== "en") {
			return undefined;
		}
		return canonical;
	} catch {
		return undefined;
	}
}

export function normalizeProviderEnglishLocale(
	value: string | readonly string[],
): string {
	const candidates = typeof value === "string" ? [value] : value;
	for (const candidate of candidates) {
		const normalized = normalizeEnglishLocale(candidate);
		if (normalized) return normalized;
	}
	fail("provider_locale");
}

/**
 * Validates the immutable provider definition. Exact keys intentionally rule
 * out endpoints, runtime URLs, tokens, fetch hooks, and provider commands.
 */
export function defineMailboxProvider(provider: MailboxProvider): MailboxProvider {
	const candidate = dataObject(provider);
	const keys = Object.keys(candidate);
	if (
		keys.length !== PROVIDER_KEYS.length ||
		!PROVIDER_KEYS.every((key) => keys.includes(key))
	) {
		fail("provider_shape");
	}
	if (
		typeof candidate.id !== "string" ||
		!MAILBOX_PROVIDER_ID_PATTERN.test(candidate.id)
	) {
		fail("provider_id");
	}
	if (
		!Array.isArray(candidate.surfaces) ||
		candidate.surfaces.length === 0 ||
		candidate.surfaces.length > 16
	) {
		fail("provider_surface");
	}
	const surfaces = candidate.surfaces as unknown[];
	if (
		surfaces.some(
			(surface) =>
				typeof surface !== "string" || !SURFACE_PATTERN.test(surface),
		) ||
		new Set(surfaces).size !== surfaces.length
	) {
		fail("provider_surface");
	}
	for (const method of PROVIDER_KEYS.slice(2)) {
		if (typeof candidate[method] !== "function") fail("provider_shape");
	}

	const frozen = {
		...provider,
		surfaces: Object.freeze([...provider.surfaces]),
	};
	return Object.freeze(frozen);
}

async function assertDefinedMailboxProviderPageReady(
	provider: MailboxProvider,
	surface: string,
): Promise<string> {
	if (!provider.surfaces.includes(surface)) fail("provider_surface");
	let localeValue: string | readonly string[];
	try {
		localeValue = await provider.readLocale();
	} catch {
		fail("provider_failure");
	}
	let locale: string;
	try {
		locale = normalizeProviderEnglishLocale(localeValue);
	} catch (error) {
		if (error instanceof MailboxProviderConfigurationError) throw error;
		fail("provider_locale");
	}
	let matched = false;
	try {
		matched =
			(await provider.hasPositiveLayoutSignature(surface)) === true;
	} catch {
		fail("layout_signature");
	}
	if (!matched) fail("layout_signature");
	return locale;
}

/** Fail closed unless the provider itself positively recognizes the page. */
export async function assertMailboxProviderPageReady(
	provider: MailboxProvider,
	surface: string,
): Promise<string> {
	return assertDefinedMailboxProviderPageReady(
		defineMailboxProvider(provider),
		surface,
	);
}

export async function guardedProviderCapture(
	provider: MailboxProvider,
	request: MailboxProviderCaptureRequest,
): Promise<unknown> {
	const safeProvider = defineMailboxProvider(provider);
	const safeRequest = validateCaptureRequest(request);
	if (safeRequest.providerId !== safeProvider.id) fail("provider_id");
	await assertDefinedMailboxProviderPageReady(
		safeProvider,
		safeRequest.surface,
	);
	try {
		return await safeProvider.capture(safeRequest);
	} catch {
		fail("provider_failure");
	}
}

export async function guardedProviderApply(
	provider: MailboxProvider,
	request: MailboxProviderMutationRequest,
): Promise<MailboxProviderObservation> {
	const safeProvider = defineMailboxProvider(provider);
	const safeRequest = validateMutationRequest(request);
	if (safeRequest.providerId !== safeProvider.id) fail("provider_id");
	await assertDefinedMailboxProviderPageReady(
		safeProvider,
		safeRequest.surface,
	);
	try {
		return validateMailboxProviderObservation(
			await safeProvider.apply(safeRequest),
		);
	} catch (error) {
		if (error instanceof MailboxProviderConfigurationError) throw error;
		fail("provider_failure");
	}
}

export async function guardedProviderVerify(
	provider: MailboxProvider,
	request: MailboxProviderVerificationRequest,
): Promise<MailboxActionResult> {
	const safeProvider = defineMailboxProvider(provider);
	const safeRequest = validateVerificationRequest(request);
	if (safeRequest.providerId !== safeProvider.id) fail("provider_id");
	await assertDefinedMailboxProviderPageReady(
		safeProvider,
		safeRequest.surface,
	);
	try {
		const result = validateMailboxActionResult(
			await safeProvider.verify(safeRequest),
		);
		if (!actionsMatch(safeRequest.action, result.action)) {
			fail("action_mismatch");
		}
		return result;
	} catch (error) {
		if (error instanceof MailboxProviderConfigurationError) throw error;
		fail("provider_failure");
	}
}
