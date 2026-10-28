export const TIERS = ["critical", "high", "medium", "low", "nit"] as const;
export type Tier = (typeof TIERS)[number];

/** Hidden tag in every thrash review body, so a custom heading still marks the review as thrash's. */
export const THRASH_REVIEW_MARKER = "<!-- dg:thrash-review -->";

/** Hidden tag that opens a JSON array of this review's bug class names, lowercase, so a later run can read them back. */
export const THRASH_CLASSES_MARKER_PREFIX = "<!-- dg:thrash-classes ";

/** Hidden tag that opens an inline comment's JSON finding key, so a later round can tell whether a finding came back. */
export const THRASH_FINDING_MARKER_PREFIX = "<!-- dg:thrash-finding ";

/** Merged PRs whose thrash reviews feed the repeated-class hint. */
export const CLASS_HISTORY_PRS = 10;

/** Recent PRs that must share a class before the summary suggests a rule or a lint check. */
export const CLASS_HINT_MIN_PRS = 3;

/** Hidden tag that opens a JSON array of keys for blocking findings a review did not post inline. */
export const THRASH_UNPOSTED_MARKER_PREFIX = "<!-- dg:thrash-unposted ";

/** Hidden tag that opens a JSON array of thread ids a review cleared, so later rounds keep them out of the open tally. */
export const THRASH_CLEARED_MARKER_PREFIX = "<!-- dg:thrash-cleared ";
