import type { CommandEntry } from "@dg/common";

/**
 * Daemon-wide $ dispatch ceilings — conceptually alongside @dg/common's
 * CHAT_MAX_* constants, declared here instead since chat-format.ts is a
 * parallel slice's file this pass. An entry's `limits` override may only
 * lower these, never raise past them.
 */
export const DISPATCH_MAX_TIMEOUT_MS = 30_000;
export const DISPATCH_MAX_OUTPUT_BYTES = 262_144; // 256 KiB
export const DISPATCH_MAX_CONCURRENT_PER_SESSION = 2;
export const DISPATCH_MAX_CONCURRENT_DAEMON_WIDE = 8; // daemon-wide only, not per-entry overridable
export const DISPATCH_MAX_INVOCATIONS_PER_MINUTE = 60;
export const DISPATCH_KILL_GRACE_MS = 500; // TERM-to-KILL escalation window

export type CommandLimitOverrides = {
	timeoutMs?: number;
	maxOutputBytes?: number;
	maxConcurrentPerSession?: number;
	maxInvocationsPerMinute?: number;
};

/**
 * `limits?` isn't on CommandEntry itself (chat-format.ts is off-limits this
 * pass) — validateCommandManifest doesn't reject the extra property, so it
 * survives the wire and the manifest store untouched; this is the read-side view.
 */
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
