import { fail, requireOneOf, requireRecord } from "../assert";
import { PW_EXT_MAX_TAB_ID } from "../pw-ext-format";

export const VERBS = ["go-back", "go-forward", "reload"] as const;

export type NavigationVerb = (typeof VERBS)[number];

export type NavigationRequest = { verb: NavigationVerb; tabId?: number };

export type NavigationResult = { ok: true; data: { text: string } } | { ok: false; error: string };

export function validate(value: unknown): NavigationRequest {
	const path = "pw-ext navigation request";
	requireRecord(value, path);
	requireOneOf(value.verb, `${path}.verb`, VERBS);
	for (const key of Object.keys(value)) if (key !== "verb" && key !== "tabId") fail(`${path} has unknown field "${key}"`);
	if (value.tabId === undefined) return { verb: value.verb };
	if (
		typeof value.tabId !== "number" ||
		!Number.isSafeInteger(value.tabId) ||
		value.tabId < 0 ||
		value.tabId > PW_EXT_MAX_TAB_ID
	)
		fail(`${path}.tabId must be a non-negative integer`);
	return { verb: value.verb, tabId: value.tabId };
}
