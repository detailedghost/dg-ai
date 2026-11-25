import { fail, requireOneOf, requireRecord } from "../assert";
import { requireTabId } from "../pw-ext-limits";

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
	requireTabId(value.tabId, path);
	return { verb: value.verb, tabId: value.tabId };
}
