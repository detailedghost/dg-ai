export const TIERS = ["critical", "high", "medium", "low", "nit"] as const;
export type Tier = (typeof TIERS)[number];

/** Hidden tag in every thrash review body, so a custom heading still marks the review as thrash's. */
export const THRASH_REVIEW_MARKER = "<!-- dg:thrash-review -->";

/** Hidden tag that opens a JSON array of this review's bug class names, lowercase, so a later run can read them back. */
export const THRASH_CLASSES_MARKER_PREFIX = "<!-- dg:thrash-classes ";
