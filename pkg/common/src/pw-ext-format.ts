import { fail, requireRecord, requireString } from "./assert";
import { PROTO_PREVIEW_MAX_CHARS } from "./proto-format";
import { PW_EXT_NETWORK_MAX_FILTER_CHARS, PW_EXT_NETWORK_MAX_LIMIT } from "./pw-ext-network";
import { PW_EXT_CREDENTIAL_NAME, PW_EXT_CREDENTIAL_SOURCES, type PwExtCredentialSource } from "./pw-ext-credential-format";
import type { RelayWire } from "./relay-format";

export const PW_EXT_READ_VERBS = [
	"current",
	"snapshot",
	"screenshot",
	"selection",
	"console",
	"tools",
	"tabs",
	"count",
	"network",
	"storage",
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
	"unmask",
	"dialog",
	"fetch",
	"credential",
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
/** Upper bound and default length of a user-approved unmask grant. */
export const PW_EXT_UNMASK_MAX_MINUTES = 60;
export const PW_EXT_UNMASK_DEFAULT_MINUTES = 15;
/** Shortest secret fill value, so masking it never wrecks the rest of the output. */
export const PW_EXT_MIN_SECRET_CHARS = 4;

/** True when a secret fill value, with white space runs counted as one, is shorter than PW_EXT_MIN_SECRET_CHARS. */
export function isPwExtSecretTooShort(value: string): boolean {
	return value.replace(/\s+/g, " ").length < PW_EXT_MIN_SECRET_CHARS;
}
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
	/** fill only: the value is a secret from the CLI's env or stdin; never echoed. */
	secret?: boolean;
	minutes?: number;
	off?: boolean;
	/** dialog only: how the page's next alert, confirm or prompt is answered. */
	answer?: "accept" | "dismiss";
	/** dialog accept only: the answer a prompt gets. */
	text?: string;
	/** network only: a substring of the shape URL. */
	filter?: string;
	limit?: number;
	/** network only: requests that started after this time in ms, or clear to empty the buffer. */
	since?: number | "clear";
	/** network, storage and fetch: show values, after a once-per-session approval in the browser. */
	values?: boolean;
	/** fetch only. */
	method?: string;
	body?: string;
	contentType?: string;
	headers?: [string, string][];
	/** fetch only: attach the page's own sign-in headers, which never leave the page. */
	auth?: "page";
	/** storage only. */
	area?: "local" | "session";
	/** storage: one key; credential: the cookie, header or storage key to save. */
	key?: string;
	keysOnly?: boolean;
	/** credential only: the short name under pw/<site>/. */
	name?: string;
	source?: PwExtCredentialSource;
	/** credential only: a dotted path into a JSON value. */
	path?: string;
};

export const PW_EXT_FETCH_MAX_BODY_BYTES = 16_384;
export const PW_EXT_FETCH_MAX_HEADERS = 20;
export const PW_EXT_MAX_KEY_CHARS = 512;
export const PW_EXT_MAX_PATH_CHARS = 256;
const HEADER_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const JSON_PATH = /^[A-Za-z0-9_$-]+(?:\.[A-Za-z0-9_$-]+)*$/;

export type PwExtTool = {
	name: string;
	title?: string;
	description: string;
	inputSchema?: string;
	annotations?: string;
};

export const PW_EXT_NO_TAB_ERROR = "This agent has no tab yet. Run pw --ext new <url> first.";

export const PW_EXT_MAX_TOOLS = 100;

/** Redacted, size-capped output; image is a screenshot data URL; tools is the structured list of the tools verb. */
export type PwExtResponse = { text: string; image?: string; tools?: PwExtTool[] };

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

export function isPwExtCliResult(requestId: string) {
	return (value: unknown): value is PwExtCliResult => {
		const frame = value as Partial<PwExtCliResult> | null;
		return (
			typeof frame === "object" &&
			frame !== null &&
			frame.type === "cli-pw-ext-result" &&
			frame.requestId === requestId
		);
	};
}

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
	count: ["tabId", "target"],
	fill: ["tabId", "target", "value", "secret"],
	unmask: ["tabId", "minutes", "off"],
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
	dialog: ["tabId", "answer", "text"],
	network: ["tabId", "filter", "limit", "since", "values"],
	storage: ["tabId", "area", "key", "keysOnly", "values"],
	fetch: ["tabId", "url", "method", "body", "contentType", "headers", "auth", "values"],
	credential: ["tabId", "name", "source", "key", "path"],
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
	if (verb === "storage") {
		if (value.area !== undefined && value.area !== "local" && value.area !== "session")
			fail(`${path}.area must be local or session`);
		if (value.key !== undefined) {
			requireString(value.key, `${path}.key`, { nonEmpty: true });
			if (value.key.length > PW_EXT_MAX_KEY_CHARS) fail(`${path}.key is too long`);
		}
		if (value.keysOnly !== undefined && value.keysOnly !== true) fail(`${path}.keysOnly must be true when set`);
		if (value.values !== undefined && value.values !== true) fail(`${path}.values must be true when set`);
		if (value.keysOnly && (value.values || value.key !== undefined))
			fail(`${path}.keysOnly takes no key and no values`);
	}
	if (verb === "fetch") {
		requireString(value.url, `${path}.url`, { nonEmpty: true });
		if (value.url.length > PW_EXT_MAX_URL_CHARS) fail(`${path}.url exceeds ${PW_EXT_MAX_URL_CHARS} characters`);
		if (!value.url.startsWith("/") && !isPwExtWebUrl(value.url))
			fail(`${path}.url must be a path that starts with / or an http or https URL`);
		if (value.method !== undefined && (typeof value.method !== "string" || !/^[A-Z]{1,16}$/.test(value.method)))
			fail(`${path}.method must be an upper-case HTTP method`);
		if (value.body !== undefined) {
			requireString(value.body, `${path}.body`);
			if (bytes(value.body) > PW_EXT_FETCH_MAX_BODY_BYTES)
				fail(`${path}.body exceeds ${PW_EXT_FETCH_MAX_BODY_BYTES} bytes`);
			if (value.method === undefined || value.method === "GET" || value.method === "HEAD")
				fail(`${path}.body needs a method other than GET or HEAD`);
		}
		if (value.contentType !== undefined) {
			requireString(value.contentType, `${path}.contentType`);
			if (!MIME.test(value.contentType.split(";")[0]?.trim() ?? "") || value.contentType.length > 128)
				fail(`${path}.contentType must be a MIME type`);
		}
		if (value.headers !== undefined) {
			if (!Array.isArray(value.headers) || value.headers.length > PW_EXT_FETCH_MAX_HEADERS)
				fail(`${path}.headers must be at most ${PW_EXT_FETCH_MAX_HEADERS} pairs`);
			for (const [index, pair] of (value.headers as unknown[]).entries()) {
				if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || typeof pair[1] !== "string")
					fail(`${path}.headers[${index}] must be a name and a value`);
				if (!HEADER_TOKEN.test(pair[0])) fail(`${path}.headers[${index}] has a bad header name`);
				if (bytes(pair[1]) > PW_EXT_MAX_VALUE_BYTES) fail(`${path}.headers[${index}] value is too long`);
			}
		}
		if (value.auth !== undefined && value.auth !== "page") fail(`${path}.auth must be page`);
		if (value.values !== undefined && value.values !== true) fail(`${path}.values must be true when set`);
	}
	if (verb === "credential") {
		if (typeof value.name !== "string" || !PW_EXT_CREDENTIAL_NAME.test(value.name))
			fail(`${path}.name must be 1 to 64 lower-case letters, digits, dots, underscores or hyphens`);
		if (!(PW_EXT_CREDENTIAL_SOURCES as readonly unknown[]).includes(value.source))
			fail(`${path}.source must be cookie, header, local or session`);
		requireString(value.key, `${path}.key`, { nonEmpty: true });
		if (value.key.length > PW_EXT_MAX_KEY_CHARS) fail(`${path}.key is too long`);
		if (value.source === "header" && !HEADER_TOKEN.test(value.key)) fail(`${path}.key must be a header name`);
		if (value.path !== undefined) {
			requireString(value.path, `${path}.path`);
			if (value.path.length > PW_EXT_MAX_PATH_CHARS || !JSON_PATH.test(value.path))
				fail(`${path}.path must be a dotted path such as accessToken or auth.token`);
		}
	}
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
	if (verb === "click" || verb === "fill" || verb === "upload" || verb === "count") {
		requireString(value.target, `${path}.target`, { nonEmpty: true });
		if (bytes(value.target) > PW_EXT_MAX_TARGET_BYTES)
			fail(`${path}.target exceeds ${PW_EXT_MAX_TARGET_BYTES} bytes`);
	}
	if (verb === "unmask") {
		if (value.off !== undefined && value.off !== true) fail(`${path}.off must be true when set`);
		if (value.off === true && value.minutes !== undefined)
			fail(`${path}.minutes is not used with off`);
		if (
			value.off !== true &&
			(!Number.isSafeInteger(value.minutes) ||
				(value.minutes as number) < 1 ||
				(value.minutes as number) > PW_EXT_UNMASK_MAX_MINUTES)
		)
			fail(`${path}.minutes must be an integer from 1 to ${PW_EXT_UNMASK_MAX_MINUTES}`);
	}
	if (verb === "dialog") {
		if (value.answer !== undefined && value.answer !== "accept" && value.answer !== "dismiss")
			fail(`${path}.answer must be accept or dismiss`);
		if (value.text !== undefined) {
			if (value.answer !== "accept") fail(`${path}.text is used only with answer accept`);
			requireString(value.text, `${path}.text`);
			if (bytes(value.text) > PW_EXT_MAX_VALUE_BYTES)
				fail(`${path}.text exceeds ${PW_EXT_MAX_VALUE_BYTES} bytes`);
		}
	}
	if (verb === "network") {
		if (value.filter !== undefined) {
			requireString(value.filter, `${path}.filter`, { nonEmpty: true });
			if (value.filter.length > PW_EXT_NETWORK_MAX_FILTER_CHARS)
				fail(`${path}.filter exceeds ${PW_EXT_NETWORK_MAX_FILTER_CHARS} characters`);
		}
		if (
			value.limit !== undefined &&
			(!Number.isSafeInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > PW_EXT_NETWORK_MAX_LIMIT)
		)
			fail(`${path}.limit must be an integer from 1 to ${PW_EXT_NETWORK_MAX_LIMIT}`);
		if (
			value.since !== undefined &&
			value.since !== "clear" &&
			(!Number.isSafeInteger(value.since) || (value.since as number) < 0)
		)
			fail(`${path}.since must be a time in ms or clear`);
		if (value.values !== undefined && value.values !== true) fail(`${path}.values must be true when set`);
		if (value.since === "clear" && (value.filter !== undefined || value.limit !== undefined || value.values !== undefined))
			fail(`${path}.since clear takes no other option`);
	}
	if (verb === "fill") {
		if (value.secret !== undefined && value.secret !== true) fail(`${path}.secret must be true when set`);
		requireString(value.value, `${path}.value`);
		if (bytes(value.value) > PW_EXT_MAX_VALUE_BYTES)
			fail(`${path}.value exceeds ${PW_EXT_MAX_VALUE_BYTES} bytes`);
	}
	return value as PwExtRequest;
}

function validatePwExtTools(value: unknown, path: string): void {
	if (!Array.isArray(value)) fail(`${path} must be an array`);
	if (value.length > PW_EXT_MAX_TOOLS) fail(`${path} exceeds ${PW_EXT_MAX_TOOLS} entries`);
	for (const [index, tool] of value.entries()) {
		const entry = `${path}[${index}]`;
		requireRecord(tool, entry);
		onlyKeys(tool, ["name", "title", "description", "inputSchema", "annotations"], entry);
		requireString(tool.name, `${entry}.name`, { nonEmpty: true });
		if (tool.name.length > PW_EXT_MAX_TOOL_NAME_CHARS)
			fail(`${entry}.name exceeds ${PW_EXT_MAX_TOOL_NAME_CHARS} characters`);
		requireString(tool.description, `${entry}.description`);
		for (const key of ["title", "inputSchema", "annotations"])
			if (tool[key] !== undefined) requireString(tool[key], `${entry}.${key}`);
	}
}

export function validatePwExtResponse(value: unknown): PwExtResponse {
	const path = "pw-ext response";
	requireRecord(value, path);
	onlyKeys(value, ["text", "image", "tools"], path);
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
	if (value.tools !== undefined) validatePwExtTools(value.tools, `${path}.tools`);
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
