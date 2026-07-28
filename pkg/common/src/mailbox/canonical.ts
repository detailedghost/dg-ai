import {
	validateMailboxAction,
	validateMailboxActionResult,
	validateMailboxDebrief,
	validateMailboxError,
	validateMailboxInferenceOutput,
	validateMailboxInventory,
	validateMailboxPlanRevision,
	validateMailboxProviderObservation,
	validateCanonicalMailboxAction,
	validateCanonicalMailboxActions,
	validateCanonicalMailboxPlanRevision,
} from "./contracts";
import { failMailboxBoundary } from "./errors";

const MAX_CANONICAL_BYTES = 2_000_000;

function sortedValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(sortedValue);
	}
	if (value !== null && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) {
			result[key] = sortedValue(
				(value as Record<string, unknown>)[key],
			);
		}
		return result;
	}
	return Object.is(value, -0) ? 0 : value;
}

function serializeValidated(value: unknown): string {
	const serialized = `${JSON.stringify(sortedValue(value))}\n`;
	if (new TextEncoder().encode(serialized).byteLength > MAX_CANONICAL_BYTES) {
		failMailboxBoundary("size_limit");
	}
	return serialized;
}

export function serializeMailboxInventory(value: unknown): string {
	return serializeValidated(validateMailboxInventory(value));
}

export function serializeMailboxPlanRevision(value: unknown): string {
	return serializeValidated(validateMailboxPlanRevision(value));
}

export const serializeMailboxRevision = serializeMailboxPlanRevision;

export function serializeCanonicalMailboxPlanRevision(value: unknown): string {
	return serializeValidated(validateCanonicalMailboxPlanRevision(value));
}

export function serializeMailboxAction(value: unknown): string {
	return serializeValidated(validateMailboxAction(value));
}

export function serializeCanonicalMailboxAction(value: unknown): string {
	return serializeValidated(validateCanonicalMailboxAction(value));
}

export function serializeCanonicalMailboxActions(value: unknown): string {
	return serializeValidated(validateCanonicalMailboxActions(value));
}

export function serializeMailboxProviderObservation(value: unknown): string {
	return serializeValidated(validateMailboxProviderObservation(value));
}

export const serializeMailboxObservation =
	serializeMailboxProviderObservation;

export function serializeMailboxActionResult(value: unknown): string {
	return serializeValidated(validateMailboxActionResult(value));
}

export const serializeMailboxResult = serializeMailboxActionResult;

export function serializeMailboxError(value: unknown): string {
	return serializeValidated(validateMailboxError(value));
}

export function serializeMailboxInferenceOutput(value: unknown): string {
	return serializeValidated(validateMailboxInferenceOutput(value));
}

export function serializeMailboxDebrief(value: unknown): string {
	return serializeValidated(validateMailboxDebrief(value));
}
