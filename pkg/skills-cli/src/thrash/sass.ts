import type { ReviewVerdict } from "../provider/types";
import type { Tier } from "./core";

export type SassKey =
	| "clean"
	| "approve"
	| "comment"
	| "blocked"
	| Exclude<Tier, "nit">;

/** Fixed summary lines for `--sass`; `{n}` is the count of the key's tier. Every line is about code, never a person. */
export const SASS_LINES: Record<SassKey, readonly string[]> = {
	clean: [
		"Nothing to flag. Suspicious, but fine.",
		"Clean diff. The linter is jealous.",
		"No findings. Frame this one.",
		"Approved. Even the whitespace behaved.",
	],
	approve: [
		"Approved, with notes. The notes are not optional reading.",
		"Ships. The comments above are the price of admission.",
		"Good enough to merge, close enough to improve.",
	],
	comment: [
		"Notes only. The verdict stays with the humans.",
		"Comments posted. No vote, just opinions.",
	],
	blocked: ["Changes requested. The details are in the comments."],
	critical: [
		"💀 {n} Critical. This diff has a body count.",
		"💀 {n} Critical. Production would like a word.",
		"💀 {n} Critical. Do not merge this on a Friday, or any day.",
	],
	high: [
		"🔥 {n} High. Bold of you to ship this on a Friday.",
		"🔥 {n} High. The happy path is happy. The other paths are not.",
		"🔥 {n} High. Close, but the bugs got here first.",
	],
	medium: [
		"⚠️ {n} Medium. Not on fire, just smoldering.",
		"⚠️ {n} Medium. Future maintainers send their regards.",
	],
	low: [
		"🧹 {n} Low. Tidy up and it ships.",
		"🧹 {n} Low. A broom fixes this one.",
	],
};

const SASS_TIERS = ["critical", "high", "medium", "low"] as const;

export function sassKey(
	verdict: ReviewVerdict,
	tally: Record<Tier, number>,
): SassKey {
	if (verdict === "comment") return "comment";
	const top = SASS_TIERS.find((tier) => tally[tier] > 0);
	if (verdict === "approve") return top === undefined ? "clean" : "approve";
	return top ?? "blocked";
}

/** Deterministic pick, so a re-run of the same round posts the same line. */
export function pickSass(
	verdict: ReviewVerdict,
	tally: Record<Tier, number>,
	seed: number,
): string {
	const key = sassKey(verdict, tally);
	const lines = SASS_LINES[key];
	const line = lines[Math.abs(Math.trunc(seed)) % lines.length];
	const tier = SASS_TIERS.find((t) => t === key);
	return line.replace("{n}", String(tier === undefined ? 0 : tally[tier]));
}
