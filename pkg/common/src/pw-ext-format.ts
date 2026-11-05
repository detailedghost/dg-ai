import { fail, requireRecord, requireString } from "./assert";
import { PROTO_PREVIEW_MAX_CHARS } from "./proto-format";

export const PW_EXT_READ_VERBS = [
	"current",
	"snapshot",
	"screenshot",
	"selection",
	"console",
] as const;
export const PW_EXT_WRITE_VERBS = ["open", "click", "fill"] as const;
export type PwExtVerb =
	| (typeof PW_EXT_READ_VERBS)[number]
	| (typeof PW_EXT_WRITE_VERBS)[number];

/** Relay deadline used when the caller omits timeoutMs; it covers the human approval. */
export const PW_EXT_DEFAULT_TIMEOUT_MS = 120_000;
export const PW_EXT_MAX_TIMEOUT_MS = 300_000;
export const PW_EXT_MAX_TEXT_CHARS = 100_000;
export const PW_EXT_MAX_IMAGE_CHARS = PROTO_PREVIEW_MAX_CHARS;
export const PW_EXT_MAX_URL_CHARS = 2048;
export const PW_EXT_MAX_TARGET_BYTES = 512;
export const PW_EXT_MAX_VALUE_BYTES = 4096;
/** First extension release that answers pw-ext frames. */
export const PW_EXT_MIN_EXTENSION_VERSION = [1, 41, 0] as const;

/** One fixed browser action; the wire carries no code and no approval. */
export type PwExtRequest = {
	verb: PwExtVerb;
	url?: string;
	target?: string;
	value?: string;
};

/** Redacted, size-capped output; image is a screenshot data URL. */
export type PwExtResponse = { text: string; image?: string };

export type PwExtCliRequest = {
	type: "cli-pw-ext-request";
	requestId: string;
	request: PwExtRequest;
	timeoutMs?: number;
};

export type PwExtCliResult = {
	type: "cli-pw-ext-result";
	sessionId: string;
	requestId: string;
	ok: boolean;
	data?: PwExtResponse;
	error?: string;
};

const FIELDS: Record<PwExtVerb, readonly string[]> = {
	current: [],
	snapshot: [],
	screenshot: [],
	selection: [],
	console: [],
	open: ["url"],
	click: ["target"],
	fill: ["target", "value"],
};

const IMAGE_DATA_URL = /^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/]+=*$/;

function bytes(value: string): number {
	return new TextEncoder().encode(value).length;
}

function onlyKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	path: string,
): void {
	for (const key of Object.keys(value))
		if (!allowed.includes(key)) fail(`${path} has unknown field "${key}"`);
}

export function isPwExtWriteVerb(verb: PwExtVerb): boolean {
	return (PW_EXT_WRITE_VERBS as readonly string[]).includes(verb);
}

/** Only http and https pages are reachable; browser and extension pages are not. */
export function isPwExtWebUrl(value: string): boolean {
	try {
		const { protocol } = new URL(value);
		return protocol === "http:" || protocol === "https:";
	} catch {
		return false;
	}
}

export function validatePwExtRequest(value: unknown): PwExtRequest {
	const path = "pw-ext request";
	requireRecord(value, path);
	if (!Object.hasOwn(FIELDS, value.verb as string))
		fail(`${path}.verb is not a supported verb`);
	const verb = value.verb as PwExtVerb;
	onlyKeys(value, ["verb", ...FIELDS[verb]], path);
	if (verb === "open") {
		requireString(value.url, `${path}.url`, { nonEmpty: true });
		if (value.url.length > PW_EXT_MAX_URL_CHARS)
			fail(`${path}.url exceeds ${PW_EXT_MAX_URL_CHARS} characters`);
		if (!isPwExtWebUrl(value.url))
			fail(`${path}.url must be an http or https URL`);
	}
	if (verb === "click" || verb === "fill") {
		requireString(value.target, `${path}.target`, { nonEmpty: true });
		if (bytes(value.target) > PW_EXT_MAX_TARGET_BYTES)
			fail(`${path}.target exceeds ${PW_EXT_MAX_TARGET_BYTES} bytes`);
	}
	if (verb === "fill") {
		requireString(value.value, `${path}.value`);
		if (bytes(value.value) > PW_EXT_MAX_VALUE_BYTES)
			fail(`${path}.value exceeds ${PW_EXT_MAX_VALUE_BYTES} bytes`);
	}
	return value as PwExtRequest;
}

export function validatePwExtResponse(value: unknown): PwExtResponse {
	const path = "pw-ext response";
	requireRecord(value, path);
	onlyKeys(value, ["text", "image"], path);
	requireString(value.text, `${path}.text`);
	if (value.text.length > PW_EXT_MAX_TEXT_CHARS)
		fail(`${path}.text exceeds ${PW_EXT_MAX_TEXT_CHARS} characters`);
	if (value.image !== undefined) {
		requireString(value.image, `${path}.image`);
		if (value.image.length > PW_EXT_MAX_IMAGE_CHARS)
			fail(`${path}.image exceeds ${PW_EXT_MAX_IMAGE_CHARS} characters`);
		if (!IMAGE_DATA_URL.test(value.image))
			fail(`${path}.image must be a base64 JPEG or PNG data URL`);
	}
	return value as PwExtResponse;
}

export function validatePwExtRequestId(value: unknown, path: string): string {
	requireString(value, path, { nonEmpty: true });
	if (value.length > 128) fail(`${path} exceeds 128 characters`);
	return value;
}

export function validatePwExtTimeout(value: unknown, path: string): void {
	if (
		!Number.isSafeInteger(value) ||
		(value as number) < 1 ||
		(value as number) > PW_EXT_MAX_TIMEOUT_MS
	)
		fail(`${path} must be an integer between 1 and ${PW_EXT_MAX_TIMEOUT_MS}`);
}

export function validatePwExtCliRequest(value: unknown): PwExtCliRequest {
	const path = "pw-ext CLI request";
	requireRecord(value, path);
	if (value.type !== "cli-pw-ext-request")
		fail(`${path}.type must be "cli-pw-ext-request"`);
	onlyKeys(
		value,
		["type", "requestId", "request", "timeoutMs", "protocolVersion"],
		path,
	);
	validatePwExtRequestId(value.requestId, `${path}.requestId`);
	validatePwExtRequest(value.request);
	if (value.timeoutMs !== undefined)
		validatePwExtTimeout(value.timeoutMs, `${path}.timeoutMs`);
	return value as PwExtCliRequest;
}
