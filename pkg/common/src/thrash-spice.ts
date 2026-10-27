export const SPICE_MIN = 1;
export const SPICE_MAX = 5;
export const SPICE_DEFAULT = 2;

/** Nits posted per spice level; anything past the cap folds into the summary. */
export const NIT_LADDER: Record<number, number> = {
	1: 0,
	2: 5,
	3: 10,
	4: 20,
	5: Number.POSITIVE_INFINITY,
};

/** Findings allowed per tier at each spice level; one more requests changes. */
export const VERDICT_LIMITS: Record<number, Partial<Record<"critical" | "high" | "medium" | "low" | "nit", number>>> = {
	1: { critical: 0, high: 4 },
	2: { critical: 0, high: 1 },
	3: { critical: 0, high: 0, medium: 4 },
	4: { critical: 0, high: 0, medium: 2 },
	5: { critical: 0, high: 0, medium: 0, low: 4 },
};

export const TIER_EMOJI: Record<"critical" | "high" | "medium" | "low" | "nit", string> = {
	critical: "💀",
	high: "🔥",
	medium: "⚠️",
	low: "🧹",
	nit: "🔬",
};

/** Every posted or pending thrash review body starts with this; a provider adapter checks it before deleting a stale pending review, so it never deletes an unrelated draft. */
export const THRASH_REVIEW_HEADING_PREFIX = "## Thrash review ";

/** Hidden tag in every thrash review body, so a review with a custom heading is still recognized as thrash's own. */
export const THRASH_REVIEW_MARKER = "<!-- dg:thrash-review -->";
