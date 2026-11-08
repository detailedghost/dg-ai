import { fail, requireRecord, requireString } from "./assert";
import { PROTO_PREVIEW_MAX_CHARS } from "./proto-format";
import type { RelayWire } from "./relay-format";

export const PW_EXT_READ_VERBS = [
	"current",
	"snapshot",
	"screenshot",
	"selection",
	"console",
	"tools",
	"tabs",
] as const;
export const PW_EXT_WRITE_VERBS = [
	"open",
	"click",
	"fill",
	"upload",
	"call",
	"new",
	"select",
	"close",
] as const;
export type PwExtVerb =
	| (typeof PW_EXT_READ_VERBS)[number]
	| (typeof PW_EXT_WRITE_VERBS)[number];

/** Relay deadline used when the caller omits timeoutMs. */
export const PW_EXT_DEFAULT_TIMEOUT_MS = 120_000;
export const PW_EXT_MAX_TIMEOUT_MS = 300_000;
export const PW_EXT_MAX_TEXT_CHARS = 100_000;
export const PW_EXT_MAX_IMAGE_CHARS = PROTO_PREVIEW_MAX_CHARS;
export const PW_EXT_MAX_URL_CHARS = 2048;
export const PW_EXT_MAX_TARGET_BYTES = 512;
export const PW_EXT_MAX_VALUE_BYTES = 4096;
/** Same cap as the daemon asset store, CHAT_MAX_ASSET_BYTES. */
export const PW_EXT_MAX_UPLOAD_BYTES = 26_214_400;
export const PW_EXT_MAX_CALL_ARGS_BYTES = 16_384;
export const PW_EXT_MAX_TOOL_NAME_CHARS = 128;
export const PW_EXT_MAX_TAB_ID = 2_147_483_647;
/** First extension release with per-agent tab groups. */
export const PW_EXT_MIN_EXTENSION_VERSION = [1, 44, 0] as const;

/** One fixed browser action; the wire carries no code. */
export type PwExtRequest = {
	verb: PwExtVerb;
	tabId?: number;
	url?: string;
	target?: string;
	value?: string;
	assetId?: string;
	fileName?: string;
	fileSize?: number;
	fileType?: string;
	filePath?: string;
	tool?: string;
	args?: Record<string, unknown>;
};

/** Redacted, size-capped output; image is a screenshot data URL. */
export type PwExtResponse = { text: string; image?: string };

export type PwExtCliRequest = {
	type: "cli-pw-ext-request";
	requestId: string;
	request: PwExtRequest;
	timeoutMs?: number;
};

export type PwExtCliCancel = { type: "cli-pw-ext-cancel"; requestId: string };

export type PwExtCliResult = {
	type: "cli-pw-ext-result";
	sessionId: string;
	requestId: string;
	ok: boolean;
	data?: PwExtResponse;
	error?: string;
};

const FIELDS: Record<PwExtVerb, readonly string[]> = {
	current: ["tabId"],
	snapshot: ["tabId"],
	screenshot: ["tabId"],
	selection: ["tabId"],
	console: ["tabId"],
	tabs: ["tabId"],
	open: ["tabId", "url"],
	new: ["tabId", "url"],
	select: ["tabId"],
	close: ["tabId"],
	click: ["tabId", "target"],
	fill: ["tabId", "target", "value"],
	upload: [
		"tabId",
		"target",
		"assetId",
		"fileName",
		"fileSize",
		"fileType",
		"filePath",
	],
	tools: ["tabId"],
	call: ["tabId", "tool", "args"],
};

const ASSET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/i;

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
	if ((verb === "tabs" || verb === "new") && value.tabId !== undefined)
		fail(`${path}.tabId is not used by "${verb}"`);
	if (
		(value.tabId !== undefined || verb === "select") &&
		(typeof value.tabId !== "number" ||
			!Number.isSafeInteger(value.tabId) ||
			value.tabId < 0 ||
			value.tabId > PW_EXT_MAX_TAB_ID)
	)
		fail(`${path}.tabId must be a non-negative integer`);
	if (verb === "open" || (verb === "new" && value.url !== undefined)) {
		requireString(value.url, `${path}.url`, { nonEmpty: true });
		if (value.url.length > PW_EXT_MAX_URL_CHARS)
			fail(`${path}.url exceeds ${PW_EXT_MAX_URL_CHARS} characters`);
		if (!isPwExtWebUrl(value.url))
			fail(`${path}.url must be an http or https URL`);
	}
	if (verb === "upload") {
		requireString(value.assetId, `${path}.assetId`);
		if (!ASSET_ID.test(value.assetId)) fail(`${path}.assetId must be a UUID`);
		requireString(value.fileName, `${path}.fileName`, { nonEmpty: true });
		if (
			bytes(value.fileName) > 255 ||
			/[/\\\u0000]/.test(value.fileName) ||
			value.fileName === "." ||
			value.fileName === ".."
		)
			fail(`${path}.fileName must be a plain file name`);
		if (
			!Number.isSafeInteger(value.fileSize) ||
			(value.fileSize as number) < 0 ||
			(value.fileSize as number) > PW_EXT_MAX_UPLOAD_BYTES
		)
			fail(`${path}.fileSize must be 0 to ${PW_EXT_MAX_UPLOAD_BYTES} bytes`);
		requireString(value.fileType, `${path}.fileType`);
		if (!MIME.test(value.fileType)) fail(`${path}.fileType must be a MIME type`);
		requireString(value.filePath, `${path}.filePath`, { nonEmpty: true });
		if (bytes(value.filePath) > 4096) fail(`${path}.filePath is too long`);
	}
	if (verb === "call") {
		requireString(value.tool, `${path}.tool`, { nonEmpty: true });
		if (value.tool.length > PW_EXT_MAX_TOOL_NAME_CHARS)
			fail(`${path}.tool exceeds ${PW_EXT_MAX_TOOL_NAME_CHARS} characters`);
		requireRecord(value.args, `${path}.args`);
		if (bytes(JSON.stringify(value.args)) > PW_EXT_MAX_CALL_ARGS_BYTES)
			fail(`${path}.args exceeds ${PW_EXT_MAX_CALL_ARGS_BYTES} bytes`);
	}
	if (verb === "click" || verb === "fill" || verb === "upload") {
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

export function validatePwExtCliCancel(value: unknown): PwExtCliCancel {
	const path = "pw-ext CLI cancel";
	requireRecord(value, path);
	if (value.type !== "cli-pw-ext-cancel")
		fail(`${path}.type must be "cli-pw-ext-cancel"`);
	onlyKeys(value, ["type", "requestId", "protocolVersion"], path);
	validatePwExtRequestId(value.requestId, `${path}.requestId`);
	return value as PwExtCliCancel;
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

export type PwExtRelayBodies = {
	cliRequest: PwExtCliRequest;
	cliCancel: PwExtCliCancel;
	browserRequest: {
		requestId: string;
		request: PwExtRequest;
		timeoutMs: number;
	};
	browserCancel: { requestId: string };
	browserResult: {
		requestId: string;
		ok: boolean;
		data?: PwExtResponse;
		error?: string;
	};
};

function requireOnlyKeys(
	value: Record<string, unknown>,
	path: string,
	allowed: readonly string[],
): void {
	for (const key of Object.keys(value))
		if (!allowed.includes(key)) fail(`${path} has unknown field "${key}"`);
}

export const PW_EXT_WIRE = {
	name: "pw-ext",
	frames: {
		cliRequest: "cli-pw-ext-request",
		cliResult: "cli-pw-ext-result",
		cliCancel: "cli-pw-ext-cancel",
		browserRequest: "pw-ext-browser-request",
		browserResult: "pw-ext-browser-result",
		browserCancel: "pw-ext-browser-cancel",
	},
	validators: {
		"pw-ext-browser-request": (value, path) => {
			validatePwExtRequestId(value.requestId, `${path}.requestId`);
			validatePwExtRequest(value.request);
			validatePwExtTimeout(value.timeoutMs, `${path}.timeoutMs`);
			requireOnlyKeys(value, path, [
				"type",
				"protocolVersion",
				"sessionId",
				"requestId",
				"request",
				"timeoutMs",
			]);
		},
		"pw-ext-browser-cancel": (value, path) => {
			validatePwExtRequestId(value.requestId, `${path}.requestId`);
			requireOnlyKeys(value, path, [
				"type",
				"protocolVersion",
				"sessionId",
				"requestId",
			]);
		},
		"pw-ext-browser-result": (value, path) => {
			validatePwExtRequestId(value.requestId, `${path}.requestId`);
			if (typeof value.ok !== "boolean")
				fail(`${path}.ok must be a boolean`);
			if (value.ok) {
				if (value.error !== undefined)
					fail(`successful ${path} must not contain an error`);
				validatePwExtResponse(value.data);
			} else {
				if (value.data !== undefined)
					fail(`failed ${path} must not contain data`);
				requireString(value.error, `${path}.error`, { nonEmpty: true });
				if ((value.error as string).length > 2048)
					fail(`${path}.error exceeds 2048 characters`);
			}
			requireOnlyKeys(value, path, [
				"type",
				"protocolVersion",
				"sessionId",
				"token",
				"requestId",
				"ok",
				"data",
				"error",
			]);
		},
	},
	inbound: ["pw-ext-browser-result"],
} as const satisfies RelayWire;
