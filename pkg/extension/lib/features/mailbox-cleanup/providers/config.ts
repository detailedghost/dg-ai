import {
	MAILBOX_EXECUTION_ACTION_TYPES,
	MAILBOX_REASON_CODES,
	type MailboxAction,
	type MailboxActionResult,
	type MailboxCanonicalAction,
	type MailboxProviderObservation,
	preflightMailboxValue,
	serializeMailboxAction,
	validateMailboxAction,
	validateMailboxActionResult,
	validateCanonicalMailboxAction,
	validateMailboxProviderObservation,
} from "@dg/common";
import { isValidMailboxScopedAlias } from "../privacy/aliases";
import type {
	GuardedMailboxExecutionProvider,
	MailboxExecutionProvider,
	MailboxProvider,
	MailboxProviderCaptureRequest,
	MailboxProviderDispatchRequest,
	MailboxProviderDispatchResult,
	MailboxProviderFreshVerificationResult,
	MailboxProviderInboxObservation,
	MailboxProviderMutationRequest,
	MailboxProviderObserveRequest,
	MailboxProviderObserveResult,
	MailboxProviderOperationOptions,
	MailboxProviderPreflightRequest,
	MailboxProviderPreflightResult,
	MailboxProviderRawTargets,
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
const EXECUTION_REQUEST_KEYS = [
	...PROVIDER_SCOPE_KEYS,
	"action",
	"rawTargets",
] as const;
const PREFLIGHT_REQUEST_KEYS = [
	...PROVIDER_SCOPE_KEYS,
	"actions",
	"rawTargets",
] as const;
const PROVIDER_KEYS = [
	"id",
	"surfaces",
	"coordinator",
	"readLocale",
	"hasPositiveLayoutSignature",
	"capture",
	"apply",
	"verify",
] as const;
const COORDINATOR_KEYS = [
	"probe",
	"capture",
	"readBodies",
	"captureResult",
	"bindings",
] as const;
const EXECUTION_PROVIDER_KEYS = [
	"preflight",
	"dispatch",
	"observe",
	"verifyFresh",
	"observeInbox",
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
				| "provider_canceled"
				| "provider_timeout"
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

function actionTargetAliases(
	action: MailboxAction | MailboxCanonicalAction,
): readonly string[] {
	const aliases: string[] = [];
	const fields = action as unknown as Readonly<Record<string, unknown>>;
	for (const key of [
		"messageAlias",
		"folderAlias",
		"replacementFolderAlias",
		"labelAlias",
		"replacementLabelAlias",
		"filterAlias",
		"replacementFilterAlias",
	] as const) {
		if (key in fields && typeof fields[key] === "string") {
			aliases.push(fields[key]);
		}
	}
	return aliases;
}

function validateRawTargets(
	value: unknown,
	actions: readonly (MailboxAction | MailboxCanonicalAction)[],
): MailboxProviderRawTargets {
	const input = requestObject(value);
	const expected = new Set(actions.flatMap(actionTargetAliases));
	const entries = Object.entries(input);
	if (
		entries.length !== expected.size ||
		entries.length > 10_000
	) {
		fail("provider_shape");
	}
	const targets: Record<string, string> = {};
	for (const [targetAlias, rawValue] of entries) {
		const prefix = targetAlias.slice(0, targetAlias.indexOf("_"));
		if (
			!expected.has(targetAlias) ||
			!["msg", "fld", "lbl", "flt"].includes(prefix) ||
			!isValidMailboxScopedAlias(targetAlias, prefix) ||
			typeof rawValue !== "string" ||
			rawValue.length === 0 ||
			rawValue.length > 4096
		) {
			fail("provider_shape");
		}
		targets[targetAlias] = rawValue;
	}
	return Object.freeze(targets);
}

function validateDispatchRequest(
	value: unknown,
): MailboxProviderDispatchRequest {
	const request = requestObject(value);
	exactRequestKeys(request, EXECUTION_REQUEST_KEYS);
	const action = validateCanonicalMailboxAction(request.action);
	if (
		!MAILBOX_EXECUTION_ACTION_TYPES.includes(
			action.type as (typeof MAILBOX_EXECUTION_ACTION_TYPES)[number],
		)
	) {
		fail("provider_shape");
	}
	return {
		...providerScope(request),
		action,
		rawTargets: validateRawTargets(request.rawTargets, [action]),
	};
}

function validatePreflightRequest(
	value: unknown,
): MailboxProviderPreflightRequest {
	const request = requestObject(value);
	exactRequestKeys(request, PREFLIGHT_REQUEST_KEYS);
	if (!Array.isArray(request.actions) || request.actions.length > 10_000) {
		fail("provider_shape");
	}
	const actions = request.actions.map(validateCanonicalMailboxAction);
	if (
		actions.some(
			(action) =>
				!MAILBOX_EXECUTION_ACTION_TYPES.includes(
					action.type as (typeof MAILBOX_EXECUTION_ACTION_TYPES)[number],
				),
		)
	) {
		fail("provider_shape");
	}
	return {
		...providerScope(request),
		actions,
		rawTargets: validateRawTargets(request.rawTargets, actions),
	};
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
	const hasExecutionMethods = EXECUTION_PROVIDER_KEYS.some((key) =>
		keys.includes(key),
	);
	const expectedKeys = hasExecutionMethods
		? [...PROVIDER_KEYS, ...EXECUTION_PROVIDER_KEYS]
		: PROVIDER_KEYS;
	if (
		keys.length !== expectedKeys.length ||
		!expectedKeys.every((key) => keys.includes(key))
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
	for (const method of expectedKeys.slice(3)) {
		if (typeof candidate[method] !== "function") fail("provider_shape");
	}
	const coordinator = dataObject(candidate.coordinator);
	const coordinatorKeys = Object.keys(coordinator);
	if (
		coordinatorKeys.some(
			(key) => !COORDINATOR_KEYS.includes(key as never) && key !== "observe",
		) ||
		COORDINATOR_KEYS.some(
			(key) => typeof coordinator[key] !== "function",
		) ||
		(coordinator.observe !== undefined &&
			typeof coordinator.observe !== "function")
	) {
		fail("provider_shape");
	}

	const frozen = {
		...provider,
		surfaces: Object.freeze([...provider.surfaces]),
		coordinator: Object.freeze({ ...provider.coordinator }),
	};
	return Object.freeze(frozen);
}

export function defineMailboxExecutionProvider(
	provider: MailboxProvider,
): MailboxExecutionProvider {
	const safeProvider = defineMailboxProvider(provider);
	for (const method of EXECUTION_PROVIDER_KEYS) {
		if (typeof safeProvider[method] !== "function") fail("provider_shape");
	}
	return safeProvider as MailboxExecutionProvider;
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

function exactResult(
	value: unknown,
	required: readonly string[],
	optional: readonly string[] = [],
): Record<string, unknown> {
	const result = requestObject(value);
	const keys = Object.keys(result);
	if (
		required.some((key) => !Object.hasOwn(result, key)) ||
		keys.some(
			(key) => !required.includes(key) && !optional.includes(key),
		)
	) {
		fail("provider_shape");
	}
	return result;
}

function reasonCode(value: unknown): (typeof MAILBOX_REASON_CODES)[number] {
	if (
		typeof value !== "string" ||
		!(MAILBOX_REASON_CODES as readonly string[]).includes(value)
	) {
		fail("provider_shape");
	}
	return value as (typeof MAILBOX_REASON_CODES)[number];
}

function observedAt(value: unknown): string {
	if (
		typeof value !== "string" ||
		!Number.isFinite(Date.parse(value)) ||
		new Date(value).toISOString() !== value
	) {
		fail("provider_shape");
	}
	return value;
}

function validatePreflightResult(
	value: unknown,
	request: MailboxProviderPreflightRequest,
): MailboxProviderPreflightResult {
	const result = requestObject(value);
	if (result.status === "blocked") {
		const blocked = exactResult(
			result,
			["status", "reasonCode"],
			["prompt"],
		);
		if (
			blocked.prompt !== undefined &&
			![
				"login",
				"mfa",
				"captcha",
				"consent",
				"conditional_access",
			].includes(blocked.prompt as string)
		) {
			fail("provider_shape");
		}
		return {
			status: "blocked",
			reasonCode: reasonCode(blocked.reasonCode),
			...(blocked.prompt === undefined
				? {}
				: {
						prompt:
							blocked.prompt as NonNullable<
								Extract<
									MailboxProviderPreflightResult,
									{ status: "blocked" }
								>["prompt"]
							>,
					}),
		};
	}
	const ready = exactResult(result, [
		"status",
		"providerId",
		"surface",
		"accountAlias",
		"locale",
		"layout",
		"capabilities",
		"targets",
	]);
	if (
		ready.status !== "ready" ||
		ready.providerId !== request.providerId ||
		ready.surface !== request.surface ||
		ready.accountAlias !== request.accountAlias ||
		ready.layout !== "supported" ||
		ready.targets !== "available" ||
		!Array.isArray(ready.capabilities) ||
		new Set(ready.capabilities).size !== ready.capabilities.length ||
		ready.capabilities.some(
			(capability) =>
				typeof capability !== "string" ||
				!MAILBOX_EXECUTION_ACTION_TYPES.includes(
					capability as (typeof MAILBOX_EXECUTION_ACTION_TYPES)[number],
				),
		)
	) {
		fail("provider_shape");
	}
	const locale = normalizeProviderEnglishLocale(ready.locale as string);
	return {
		status: "ready",
		providerId: request.providerId,
		surface: request.surface,
		accountAlias: request.accountAlias,
		locale,
		layout: "supported",
		capabilities:
			ready.capabilities as (typeof MAILBOX_EXECUTION_ACTION_TYPES)[number][],
		targets: "available",
	};
}

function validateDispatchResult(value: unknown): MailboxProviderDispatchResult {
	const result = exactResult(value, ["status"]);
	if (result.status !== "dispatched") fail("provider_shape");
	return { status: "dispatched" };
}

function validateObserveResult(value: unknown): MailboxProviderObserveResult {
	const result = requestObject(value);
	if (result.status === "observed") {
		const observed = exactResult(result, ["status", "observedAt"]);
		return {
			status: "observed",
			observedAt: observedAt(observed.observedAt),
		};
	}
	const ambiguous = exactResult(result, ["status", "reasonCode"]);
	if (ambiguous.status !== "ambiguous") fail("provider_shape");
	return {
		status: "ambiguous",
		reasonCode: reasonCode(ambiguous.reasonCode),
	};
}

function validateFreshVerificationResult(
	value: unknown,
): MailboxProviderFreshVerificationResult {
	const result = requestObject(value);
	if (result.status === "verified") {
		const verified = exactResult(result, ["status", "verifiedAt", "delta"]);
		const delta = exactResult(verified.delta, [
			"schemaVersion",
			"scope",
			"actionAlias",
			"changedAliases",
		]);
		if (
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
			fail("provider_shape");
		}
		return {
			status: "verified",
			verifiedAt: observedAt(verified.verifiedAt),
			delta: {
				schemaVersion: 1,
				scope: "entire_fingerprint",
				actionAlias: delta.actionAlias,
				changedAliases: Object.freeze([...delta.changedAliases]),
			},
		};
	}
	const failed = exactResult(result, ["status", "reasonCode"]);
	if (
		failed.status !== "mismatch" &&
		failed.status !== "ambiguous" &&
		failed.status !== "timeout"
	) {
		fail("provider_shape");
	}
	return {
		status: failed.status,
		reasonCode: reasonCode(failed.reasonCode),
	};
}

function validateInboxObservation(
	value: unknown,
): MailboxProviderInboxObservation {
	const result = requestObject(value);
	if (result.status === "observed") {
		const observed = exactResult(result, [
			"status",
			"count",
			"observedAt",
		]);
		if (
			typeof observed.count !== "number" ||
			!Number.isSafeInteger(observed.count) ||
			observed.count < 0 ||
			observed.count > 1_000_000
		) {
			fail("provider_shape");
		}
		return {
			status: "observed",
			count: observed.count,
			observedAt: observedAt(observed.observedAt),
		};
	}
	const failed = exactResult(result, ["status", "reasonCode"]);
	if (failed.status !== "ambiguous" && failed.status !== "timeout") {
		fail("provider_shape");
	}
	return {
		status: failed.status,
		reasonCode: reasonCode(failed.reasonCode),
	};
}

async function boundedProviderOperation<T>(
	operation: (
		options: Required<MailboxProviderOperationOptions>,
	) => T | Promise<T>,
	options: MailboxProviderOperationOptions = {},
): Promise<T> {
	const timeoutMs = options.timeoutMs ?? 30_000;
	if (
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs < 1 ||
		timeoutMs > 60_000
	) {
		fail("provider_shape");
	}
	if (options.signal?.aborted) fail("provider_canceled");
	const controller = new AbortController();
	const abortOperation = (): void => controller.abort();
	options.signal?.addEventListener("abort", abortOperation, { once: true });
	const operationOptions = Object.freeze({
		signal: controller.signal,
		timeoutMs,
	});
	return await new Promise<T>((resolve, reject) => {
		let settled = false;
		const finish = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
			options.signal?.removeEventListener("abort", abortOperation);
			callback();
		};
		const abort = (): void => {
			controller.abort();
			finish(() =>
				reject(
					new MailboxProviderConfigurationError("provider_canceled"),
				),
			);
		};
		const timer = setTimeout(
			() => {
				controller.abort();
				finish(() =>
					reject(
						new MailboxProviderConfigurationError(
							"provider_timeout",
						),
					),
				);
			},
			timeoutMs,
		);
		options.signal?.addEventListener("abort", abort, { once: true });
		Promise.resolve()
			.then(() => operation(operationOptions))
			.then(
				(value) => finish(() => resolve(value)),
				() =>
					finish(() =>
						reject(
							new MailboxProviderConfigurationError(
								"provider_failure",
							),
						),
					),
			);
	});
}

export async function guardedProviderPreflight(
	provider: MailboxProvider,
	request: MailboxProviderPreflightRequest,
	options?: MailboxProviderOperationOptions,
): Promise<MailboxProviderPreflightResult> {
	const safeProvider = defineMailboxExecutionProvider(provider);
	const safeRequest = validatePreflightRequest(request);
	if (safeRequest.providerId !== safeProvider.id) fail("provider_id");
	const result = validatePreflightResult(
		await boundedProviderOperation(
			(operationOptions) =>
				safeProvider.preflight(safeRequest, operationOptions),
			options,
		),
		safeRequest,
	);
	if (result.status === "blocked") return result;
	const locale = await boundedProviderOperation(
		() =>
			assertDefinedMailboxProviderPageReady(
				safeProvider,
				safeRequest.surface,
			),
		options,
	);
	if (locale !== result.locale) fail("provider_locale");
	return result;
}

export async function guardedProviderDispatch(
	provider: MailboxProvider,
	request: MailboxProviderDispatchRequest,
	options?: MailboxProviderOperationOptions,
): Promise<MailboxProviderDispatchResult> {
	const safeProvider = defineMailboxExecutionProvider(provider);
	const safeRequest = validateDispatchRequest(request);
	if (safeRequest.providerId !== safeProvider.id) fail("provider_id");
	await boundedProviderOperation(
		() =>
			assertDefinedMailboxProviderPageReady(
				safeProvider,
				safeRequest.surface,
			),
		options,
	);
	return validateDispatchResult(
		await boundedProviderOperation(
			(operationOptions) =>
				safeProvider.dispatch(safeRequest, operationOptions),
			options,
		),
	);
}

export async function guardedProviderObserve(
	provider: MailboxProvider,
	request: MailboxProviderObserveRequest,
	options?: MailboxProviderOperationOptions,
): Promise<MailboxProviderObserveResult> {
	const safeProvider = defineMailboxExecutionProvider(provider);
	const safeRequest = validateDispatchRequest(request);
	if (safeRequest.providerId !== safeProvider.id) fail("provider_id");
	return validateObserveResult(
		await boundedProviderOperation(
			(operationOptions) =>
				safeProvider.observe(safeRequest, operationOptions),
			options,
		),
	);
}

export async function guardedProviderVerifyFresh(
	provider: MailboxProvider,
	request: MailboxProviderObserveRequest,
	options?: MailboxProviderOperationOptions,
): Promise<MailboxProviderFreshVerificationResult> {
	const safeProvider = defineMailboxExecutionProvider(provider);
	const safeRequest = validateDispatchRequest(request);
	if (safeRequest.providerId !== safeProvider.id) fail("provider_id");
	return validateFreshVerificationResult(
		await boundedProviderOperation(
			(operationOptions) =>
				safeProvider.verifyFresh(safeRequest, operationOptions),
			options,
		),
	);
}

export async function guardedProviderObserveInbox(
	provider: MailboxProvider,
	request: MailboxProviderCaptureRequest,
	options?: MailboxProviderOperationOptions,
): Promise<MailboxProviderInboxObservation> {
	const safeProvider = defineMailboxExecutionProvider(provider);
	const safeRequest = validateCaptureRequest(request);
	if (safeRequest.providerId !== safeProvider.id) fail("provider_id");
	return validateInboxObservation(
		await boundedProviderOperation(
			(operationOptions) =>
				safeProvider.observeInbox(safeRequest, operationOptions),
			options,
		),
	);
}

/**
 * Bind a raw bundled provider to the exact execution guard surface. Callers
 * never receive the raw implementation, preventing accidental guard bypass.
 */
export function createGuardedMailboxExecutionProvider(
	provider: MailboxProvider,
): GuardedMailboxExecutionProvider {
	const safeProvider = defineMailboxExecutionProvider(provider);
	return Object.freeze({
		preflight: (request, options) =>
			guardedProviderPreflight(safeProvider, request, options),
		dispatch: (request, options) =>
			guardedProviderDispatch(safeProvider, request, options),
		observe: (request, options) =>
			guardedProviderObserve(safeProvider, request, options),
		verifyFresh: (request, options) =>
			guardedProviderVerifyFresh(safeProvider, request, options),
		observeInbox: (request, options) =>
			guardedProviderObserveInbox(safeProvider, request, options),
	});
}
