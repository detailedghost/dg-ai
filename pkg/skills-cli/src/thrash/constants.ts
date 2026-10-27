export const TIERS = ["critical", "high", "medium", "low", "nit"] as const;
export type Tier = (typeof TIERS)[number];

/** Hidden tag in every thrash review body, so a custom heading still marks the review as thrash's. */
export const THRASH_REVIEW_MARKER = "<!-- dg:thrash-review -->";
