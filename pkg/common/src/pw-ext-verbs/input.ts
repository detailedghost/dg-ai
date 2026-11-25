import { fail, requireRecord, requireString } from "../assert";
import { parseKeyChord } from "../keyboard-keys";
import { PW_EXT_MAX_TAB_ID, PW_EXT_MAX_TARGET_BYTES, PW_EXT_MAX_VALUE_BYTES } from "../pw-ext-format";

export const VERBS = ["check", "uncheck", "type", "keydown", "keyup"] as const;
export type InputVerb = (typeof VERBS)[number];

type Tab = { tabId?: number };
export type InputRequest =
	| ({ verb: "check" | "uncheck"; target: string } & Tab)
	| ({ verb: "type"; text: string; submit?: true } & Tab)
	| ({ verb: "keydown" | "keyup"; key: string } & Tab);

export type InputResult = { ok: true; data: { text: string } } | { ok: false; error: string };

const FIELDS = {
	check: ["tabId", "target"],
	uncheck: ["tabId", "target"],
	type: ["tabId", "text", "submit"],
	keydown: ["tabId", "key"],
	keyup: ["tabId", "key"],
} as const satisfies Record<InputVerb, readonly string[]>;

const encoder = new TextEncoder();

export function validate(value: unknown): InputRequest {
	const path = "pw-ext input request";
	requireRecord(value, path);
	if (!Object.hasOwn(FIELDS, value.verb as string)) fail(`${path}.verb is not an input verb`);
	const verb = value.verb as InputVerb;
	const allowed: readonly string[] = ["verb", ...FIELDS[verb]];
	for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${path} has unknown field "${key}"`);
	if (
		value.tabId !== undefined &&
		(typeof value.tabId !== "number" ||
			!Number.isSafeInteger(value.tabId) ||
			value.tabId < 0 ||
			value.tabId > PW_EXT_MAX_TAB_ID)
	)
		fail(`${path}.tabId must be a non-negative integer`);
	if (verb === "check" || verb === "uncheck") {
		requireString(value.target, `${path}.target`, { nonEmpty: true });
		if (encoder.encode(value.target).length > PW_EXT_MAX_TARGET_BYTES)
			fail(`${path}.target exceeds ${PW_EXT_MAX_TARGET_BYTES} bytes`);
	}
	if (verb === "type") {
		requireString(value.text, `${path}.text`, { nonEmpty: true });
		if (encoder.encode(value.text).length > PW_EXT_MAX_VALUE_BYTES)
			fail(`${path}.text exceeds ${PW_EXT_MAX_VALUE_BYTES} bytes`);
		if (value.submit !== undefined && value.submit !== true) fail(`${path}.submit must be true when set`);
	}
	if (verb === "keydown" || verb === "keyup") {
		requireString(value.key, `${path}.key`, { nonEmpty: true });
		if (parseKeyChord(value.key)?.modifiers.length !== 0) fail(`${path}.key must be one key such as Shift or a`);
	}
	return value as InputRequest;
}
