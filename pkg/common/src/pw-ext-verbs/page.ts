import { fail, requireOneOf, requireRecord, requireString } from "../assert";
import { PW_EXT_MAX_TAB_ID } from "../pw-ext-format";

export const VERBS = ["eval", "tab-select", "resize"] as const;

export const EVAL_MAX_BYTES = 16_384;
export const RESIZE_MIN = 200;
export const RESIZE_MAX = 10_000;

export type PageVerb = (typeof VERBS)[number];

export type PageRequest =
	| { verb: "eval"; expression: string; tabId?: number }
	| { verb: "tab-select"; tabId: number }
	| { verb: "resize"; width: number; height: number; tabId?: number };

export type PageResult = { ok: true; data: { text: string } } | { ok: false; error: string };

const FIELDS = {
	eval: ["verb", "expression", "tabId"],
	"tab-select": ["verb", "tabId"],
	resize: ["verb", "width", "height", "tabId"],
} as const satisfies Record<PageVerb, readonly string[]>;

function requireTabId(value: unknown, path: string): asserts value is number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > PW_EXT_MAX_TAB_ID)
		fail(`${path}.tabId must be a non-negative integer`);
}

function requireSize(value: unknown, path: string): asserts value is number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < RESIZE_MIN || value > RESIZE_MAX)
		fail(`${path} must be a whole number between ${RESIZE_MIN} and ${RESIZE_MAX}`);
}

export function validate(value: unknown): PageRequest {
	const path = "pw-ext page request";
	requireRecord(value, path);
	requireOneOf(value.verb, `${path}.verb`, VERBS);
	const verb = value.verb;
	for (const key of Object.keys(value))
		if (!(FIELDS[verb] as readonly string[]).includes(key)) fail(`${path} has unknown field "${key}"`);
	if (verb === "tab-select") {
		requireTabId(value.tabId, path);
		return { verb, tabId: value.tabId };
	}
	if (value.tabId !== undefined) requireTabId(value.tabId, path);
	const tab = value.tabId === undefined ? {} : { tabId: value.tabId };
	if (verb === "eval") {
		requireString(value.expression, `${path}.expression`, { nonEmpty: true });
		if (new TextEncoder().encode(value.expression).length > EVAL_MAX_BYTES)
			fail(`${path}.expression is too long`);
		return { verb, expression: value.expression, ...tab };
	}
	requireSize(value.width, `${path}.width`);
	requireSize(value.height, `${path}.height`);
	return { verb, width: value.width, height: value.height, ...tab };
}
