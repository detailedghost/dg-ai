import type { CommandEntry } from "@dg/common";

export const DISPATCH_MAX_TIMEOUT_MS = 30_000;
export const DISPATCH_MAX_OUTPUT_BYTES = 262_144;
export const DISPATCH_MAX_CONCURRENT_PER_SESSION = 2;
export const DISPATCH_MAX_CONCURRENT_DAEMON_WIDE = 8;
export const DISPATCH_MAX_INVOCATIONS_PER_MINUTE = 60;
export const DISPATCH_KILL_GRACE_MS = 500;

export type CommandLimitOverrides = {
	timeoutMs?: number;
	maxOutputBytes?: number;
	maxConcurrentPerSession?: number;
	maxInvocationsPerMinute?: number;
};

export type CommandEntryWithLimits = CommandEntry & {
	limits?: CommandLimitOverrides;
};

export type ResolvedLimits = {
	timeoutMs: number;
	maxOutputBytes: number;
	maxConcurrentPerSession: number;
	maxInvocationsPerMinute: number;
};

function clamp(value: number | undefined, max: number): number {
	if (value === undefined || !Number.isFinite(value) || value < 0) return max;
	return Math.min(value, max);
}

export function resolveLimits(
	overrides?: CommandLimitOverrides,
): ResolvedLimits {
	return {
		timeoutMs: clamp(overrides?.timeoutMs, DISPATCH_MAX_TIMEOUT_MS),
		maxOutputBytes: clamp(overrides?.maxOutputBytes, DISPATCH_MAX_OUTPUT_BYTES),
		maxConcurrentPerSession: clamp(
			overrides?.maxConcurrentPerSession,
			DISPATCH_MAX_CONCURRENT_PER_SESSION,
		),
		maxInvocationsPerMinute: clamp(
			overrides?.maxInvocationsPerMinute,
			DISPATCH_MAX_INVOCATIONS_PER_MINUTE,
		),
	};
}
