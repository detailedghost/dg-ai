import { fail, requireRecord, requireString } from "../assert";
import { PW_EXT_MAX_KEY_CHARS, PW_EXT_MAX_VALUE_BYTES, type PwExtResponse, requireTabId } from "../pw-ext-limits";

export const VERBS = [
	"localstorage-set",
	"localstorage-delete",
	"localstorage-clear",
	"sessionstorage-set",
	"sessionstorage-delete",
	"sessionstorage-clear",
] as const;

export type StorageVerb = (typeof VERBS)[number];
export type StorageArea = "local" | "session";
export type StorageAction = "set" | "delete" | "clear";

export type StorageRequest = {
	verb: StorageVerb;
	tabId?: number;
	key?: string;
	value?: string;
};

export type StorageResult =
	| { ok: true; data: PwExtResponse }
	| { ok: false; error: string };

export function storageAreaOf(verb: StorageVerb): StorageArea {
	return verb.startsWith("local") ? "local" : "session";
}

export function storageActionOf(verb: StorageVerb): StorageAction {
	return verb.slice(verb.lastIndexOf("-") + 1) as StorageAction;
}

export function validate(value: unknown): StorageRequest {
	const path = "storage request";
	requireRecord(value, path);
	if (!(VERBS as readonly unknown[]).includes(value.verb))
		fail(`${path}.verb is not a supported verb`);
	const verb = value.verb as StorageVerb;
	const action = storageActionOf(verb);
	for (const name of Object.keys(value))
		if (name !== "verb" && name !== "tabId" && name !== "key" && name !== "value")
			fail(`${path}.${name} is not used by "${verb}"`);
	if (value.tabId !== undefined) requireTabId(value.tabId, path);
	if (action === "clear") {
		if (value.key !== undefined) fail(`${path}.key is not used by "${verb}"`);
	} else {
		requireString(value.key, `${path}.key`, { nonEmpty: true });
		if (value.key.length > PW_EXT_MAX_KEY_CHARS) fail(`${path}.key is too long`);
	}
	if (action === "set") {
		requireString(value.value, `${path}.value`);
		if (new TextEncoder().encode(value.value).length > PW_EXT_MAX_VALUE_BYTES)
			fail(`${path}.value is too long`);
	} else if (value.value !== undefined) fail(`${path}.value is not used by "${verb}"`);
	return value as StorageRequest;
}
