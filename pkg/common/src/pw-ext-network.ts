import { fail, requireRecord, requireString } from "./assert";

/** Ring size of the page network hook. */
export const PW_EXT_NETWORK_MAX_ENTRIES = 100;
export const PW_EXT_NETWORK_DEFAULT_LIMIT = 50;
export const PW_EXT_NETWORK_MAX_LIMIT = 200;
export const PW_EXT_NETWORK_MAX_FILTER_CHARS = 200;
export const PW_EXT_NETWORK_MAX_URL_CHARS = 4096;
export const PW_EXT_NETWORK_MAX_HEADERS = 40;
export const PW_EXT_NETWORK_MAX_HEADER_VALUE_CHARS = 512;
export const PW_EXT_NETWORK_MAX_BODY_CHARS = 8000;
export const PW_EXT_NETWORK_MAX_SHAPE_DEPTH = 8;
export const PW_EXT_NETWORK_MAX_SHAPE_KEYS = 40;
export const PW_EXT_NETWORK_MAX_SHAPE_NODES = 400;

const SHAPE_TEXT_MAX = 2000;
const TYPE_MAX = 128;

export type NetworkShape =
	| "string"
	| "number"
	| "boolean"
	| "null"
	| { n: number; of?: NetworkShape }
	| { keys: [string, NetworkShape][]; more?: number };

/** One request or response body: content type, byte size (-1 when unknown), JSON key structure, and raw text only on a values read. */
export type NetworkBody = { type: string; size: number; shape?: NetworkShape; text?: string; cut?: boolean };

/** A header name; value is set only on a values read and never for a sensitive header. */
export type NetworkHeader = { name: string; value?: string };

export type NetworkEntry = {
	at: number;
	via: "fetch" | "xhr";
	method: string;
	url: string;
	status?: number;
	failed?: true;
	requestHeaders: NetworkHeader[];
	responseHeaders: NetworkHeader[];
	request?: NetworkBody;
	response?: NetworkBody;
};

const CREDENTIAL_FIELD =
	/pass|pwd|secret|token|key|auth|credential|session|cookie|canary|csrf|xsrf|signature|jwt|dpop|bearer|assertion|^otp$|^pin$|^code$/i;
const JSON_FIELD = /"((?:[^"\\]|\\.){1,256})"(\s*:\s*)("(?:[^"\\]|\\.)*"?|-?\d[\d.eE+-]*|true|false)/g;
const JSON_NESTED = /"((?:[^"\\]|\\.){1,256})"\s*:\s*[[{]/g;
const USER_INFO = /^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]*@/i;
const CONTENT_TYPE = /^\s*([\w.+-]{1,60}\/[\w.+-]{1,60})\s*(?:;\s*charset=["']?([\w-]{1,32}))?/i;
const FORM_FIELD = /(^|[?&;\s])([^=&;\s?#]{1,256})=([^&;\s#]*)/g;
const SENSITIVE_HEADER =
	/auth|cookie|token|secret|key|session|canary|csrf|xsrf|credential|pass|signature|jwt|dpop|bearer|assertion/i;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const PLAIN_KEY = /^[@$_]{0,2}[A-Za-z][A-Za-z0-9_.:$-]{0,63}$/;
const PLAIN_SEGMENT = /^[A-Za-z0-9._~$!-]{1,64}$/;
const API_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const API_NAME_PARAMS = new Set(["action", "app"]);
const MASK = "*";

function credentialName(raw: string): boolean {
	let name = raw;
	try {
		name = JSON.parse(`"${raw}"`) as string;
	} catch {}
	return CREDENTIAL_FIELD.test(name);
}

function maskTree(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(maskTree);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, inner]) => [key, CREDENTIAL_FIELD.test(key) ? "[redacted]" : maskTree(inner)]),
	);
}

function maskJsonText(text: string): string {
	if (/^\s*[[{]/.test(text))
		try {
			return JSON.stringify(maskTree(JSON.parse(text)));
		} catch {}
	const flat = text.replace(JSON_FIELD, (match, name: string, gap: string) =>
		credentialName(name) ? `"${name}"${gap}"[redacted]"` : match,
	);
	for (const match of flat.matchAll(JSON_NESTED))
		if (credentialName(match[1] as string))
			return `${flat.slice(0, (match.index ?? 0) + match[0].length - 1)}"[redacted]" [rest hidden]`;
	return flat;
}

/** Masks each JSON field, nested value or form and query parameter whose name names a credential, and URL user info; cut text is masked too. */
export function maskCredentialFields(text: string): string {
	return maskJsonText(text.replace(USER_INFO, "$1[redacted]@")).replace(FORM_FIELD, (match, lead: string, name: string) =>
		CREDENTIAL_FIELD.test(decoded(name)) ? `${lead}${name}=[redacted]` : match,
	);
}

/** The media type and charset of a content-type value, or * when it is not one; other parameters are dropped. */
export function shownContentType(raw: string): string {
	if (raw.trim() === "") return "no content type";
	const match = CONTENT_TYPE.exec(raw);
	if (!match) return MASK;
	return match[2] ? `${match[1]}; charset=${match[2]}` : (match[1] as string);
}

/** True for a header whose value can carry a credential; such a value is never captured or shown. */
export function isSensitiveHeader(name: string): boolean {
	return SENSITIVE_HEADER.test(name);
}

/** True for text that looks like a generated identifier rather than a word, so output masks it. */
export function looksLikeOpaqueId(value: string): boolean {
	if (/^\d{5,}$/.test(value)) return true;
	if (/\s/.test(value)) return false;
	if (value.length >= 12 && /[%=+/]/.test(value)) return true;
	if (value.length < 16) return false;
	if (/\d/.test(value) && /[A-Za-z]/.test(value)) return true;
	const letters = value.replace(/[^A-Za-z]/g, "");
	const upper = value.replace(/[^A-Z]/g, "").length;
	return value.length >= 20 && /[a-z]/.test(value) && upper >= letters.length * 0.3;
}

function plainKey(key: string): string {
	return PLAIN_KEY.test(key) && !looksLikeOpaqueId(key) ? key : MASK;
}

function decoded(segment: string): string {
	try {
		return decodeURIComponent(segment);
	} catch {
		return segment;
	}
}

function plainSegment(segment: string): string {
	if (segment === "") return segment;
	const text = decoded(segment);
	return PLAIN_SEGMENT.test(text) && !looksLikeOpaqueId(text) ? text : MASK;
}

/** The URL with user info, fragment and query values removed, id-like path segments masked, and the value of action or app kept only when it is a plain API name. */
export function networkUrlShape(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return "(unparsable URL)";
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return url.protocol;
	const path = url.pathname.split("/").map(plainSegment).join("/");
	const params = url.search
		.slice(1)
		.split("&")
		.filter((part) => part !== "")
		.map((part) => {
			const at = part.indexOf("=");
			const name = decoded(at === -1 ? part : part.slice(0, at));
			const value = at === -1 ? undefined : decoded(part.slice(at + 1));
			const shownName = plainKey(name);
			if (value === undefined) return shownName;
			const keep =
				shownName !== MASK && API_NAME_PARAMS.has(name.toLowerCase()) && API_NAME.test(value) && !looksLikeOpaqueId(value);
			return `${shownName}=${keep ? value : MASK}`;
		});
	return `${url.protocol}//${url.host}${path}${params.length ? `?${params.join("&")}` : ""}`;
}

/** Renders a JSON key structure with value types; it holds no values, and id-like keys show as *. */
export function renderNetworkShape(shape: NetworkShape): string {
	if (typeof shape === "string") return shape;
	if ("n" in shape) return shape.of === undefined ? `[${shape.n}]` : `[${shape.n} x ${renderNetworkShape(shape.of)}]`;
	const parts = shape.keys.map(([key, value]) => `${plainKey(key)} ${renderNetworkShape(value)}`);
	if (shape.more) parts.push(`+${shape.more} more`);
	return `{${parts.join(", ")}}`;
}

function validateShape(value: unknown, path: string, depth: number, budget: { nodes: number }): void {
	if (--budget.nodes < 0) fail(`${path} has too many nodes`);
	if (depth > PW_EXT_NETWORK_MAX_SHAPE_DEPTH) fail(`${path} is too deep`);
	if (value === "string" || value === "number" || value === "boolean" || value === "null") return;
	requireRecord(value, path);
	if ("n" in value) {
		onlyKeys(value, ["n", "of"], path);
		if (!Number.isSafeInteger(value.n) || (value.n as number) < 0) fail(`${path}.n must be a count`);
		if (value.of !== undefined) validateShape(value.of, `${path}.of`, depth + 1, budget);
		return;
	}
	onlyKeys(value, ["keys", "more"], path);
	if (!Array.isArray(value.keys) || value.keys.length > PW_EXT_NETWORK_MAX_SHAPE_KEYS) fail(`${path}.keys must be a short array`);
	if (value.more !== undefined && (!Number.isSafeInteger(value.more) || (value.more as number) < 1))
		fail(`${path}.more must be a positive count`);
	for (const [index, pair] of (value.keys as unknown[]).entries()) {
		if (!Array.isArray(pair) || pair.length !== 2) fail(`${path}.keys[${index}] must be a pair`);
		requireString(pair[0], `${path}.keys[${index}][0]`);
		if (pair[0].length > 256) fail(`${path}.keys[${index}][0] is too long`);
		validateShape(pair[1], `${path}.keys[${index}][1]`, depth + 1, budget);
	}
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
	for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${path} has unknown field "${key}"`);
}

function validateHeaders(value: unknown, path: string): void {
	if (!Array.isArray(value) || value.length > PW_EXT_NETWORK_MAX_HEADERS) fail(`${path} must be a short array`);
	for (const [index, header] of value.entries()) {
		const at = `${path}[${index}]`;
		requireRecord(header, at);
		onlyKeys(header, ["name", "value"], at);
		requireString(header.name, `${at}.name`);
		if (!HEADER_NAME.test(header.name)) fail(`${at}.name is not a header name`);
		if (header.value !== undefined) {
			requireString(header.value, `${at}.value`);
			if (header.value.length > PW_EXT_NETWORK_MAX_HEADER_VALUE_CHARS + 1) fail(`${at}.value is too long`);
		}
	}
}

function validateBody(value: unknown, path: string): void {
	requireRecord(value, path);
	onlyKeys(value, ["type", "size", "shape", "text", "cut"], path);
	requireString(value.type, `${path}.type`);
	if (value.type.length > TYPE_MAX) fail(`${path}.type is too long`);
	if (!Number.isSafeInteger(value.size) || (value.size as number) < -1) fail(`${path}.size must be a byte count or -1`);
	if (value.shape !== undefined) validateShape(value.shape, `${path}.shape`, 0, { nodes: PW_EXT_NETWORK_MAX_SHAPE_NODES });
	if (value.text !== undefined) {
		requireString(value.text, `${path}.text`);
		if (value.text.length > PW_EXT_NETWORK_MAX_BODY_CHARS + 1) fail(`${path}.text is too long`);
	}
	if (value.cut !== undefined && value.cut !== true) fail(`${path}.cut must be true when set`);
}

/** Checks the raw result of the page network hook before the worker formats it. */
export function validateNetworkEntries(raw: unknown): NetworkEntry[] {
	const path = "network result";
	requireRecord(raw, path);
	const entries = raw.entries;
	if (!Array.isArray(entries) || entries.length > PW_EXT_NETWORK_MAX_ENTRIES) fail(`${path}.entries must be a short array`);
	for (const [index, entry] of entries.entries()) {
		const at = `${path}.entries[${index}]`;
		requireRecord(entry, at);
		onlyKeys(
			entry,
			["at", "via", "method", "url", "status", "failed", "requestHeaders", "responseHeaders", "request", "response"],
			at,
		);
		if (typeof entry.at !== "number" || !Number.isFinite(entry.at)) fail(`${at}.at must be a time`);
		if (entry.via !== "fetch" && entry.via !== "xhr") fail(`${at}.via must be fetch or xhr`);
		requireString(entry.method, `${at}.method`);
		if (!/^[A-Za-z]{1,16}$/.test(entry.method)) fail(`${at}.method is not a method`);
		requireString(entry.url, `${at}.url`);
		if (entry.url.length > PW_EXT_NETWORK_MAX_URL_CHARS) fail(`${at}.url is too long`);
		if (entry.status !== undefined && (!Number.isSafeInteger(entry.status) || (entry.status as number) < 0 || (entry.status as number) > 999))
			fail(`${at}.status must be an HTTP status`);
		if (entry.failed !== undefined && entry.failed !== true) fail(`${at}.failed must be true when set`);
		validateHeaders(entry.requestHeaders, `${at}.requestHeaders`);
		validateHeaders(entry.responseHeaders, `${at}.responseHeaders`);
		if (entry.request !== undefined) validateBody(entry.request, `${at}.request`);
		if (entry.response !== undefined) validateBody(entry.response, `${at}.response`);
	}
	return entries as NetworkEntry[];
}

const clock = (at: number) => new Date(at).toTimeString().slice(0, 8);

function bodyLine(label: string, body: NetworkBody, values: boolean, value: (text: string) => string): string[] {
	const size = body.size >= 0 ? `, ${body.size} bytes` : "";
	const shape = body.shape === undefined ? "" : ` ${clipShape(renderNetworkShape(body.shape))}`;
	const head = `  ${label}: ${shownContentType(body.type)}${size}`;
	if (!values) return [`${head}${shape}`];
	if (body.text === undefined) return [head];
	const text = maskCredentialFields(body.text);
	return [head, `    ${value(body.cut ? `${text}…` : text).replace(/\s+/g, " ")}`];
}

function clipShape(text: string): string {
	return text.length > SHAPE_TEXT_MAX ? `${text.slice(0, SHAPE_TEXT_MAX)}…` : text;
}

function headerLine(label: string, headers: NetworkHeader[], values: boolean, value: (text: string) => string): string[] {
	if (!headers.length) return [];
	const shown = headers.map(({ name, value: raw }) =>
		!values
			? name
			: raw === undefined || isSensitiveHeader(name)
				? `${name} (hidden)`
				: `${name}: ${value(raw.length >= PW_EXT_NETWORK_MAX_HEADER_VALUE_CHARS ? `${raw}…` : raw)}`,
	);
	return [`  ${label}: ${shown.join(", ")}`];
}

/** Formats captured requests, newest last; filter matches the shape URL only, so it cannot probe a hidden value, and value() masks each shown value, which ends in an ellipsis where the page cut it. */
export function formatNetwork(
	entries: readonly NetworkEntry[],
	{
		values,
		value,
		filter,
		limit = PW_EXT_NETWORK_DEFAULT_LIMIT,
	}: { values: boolean; value: (text: string) => string; filter?: string; limit?: number },
): string[] {
	const needle = filter?.toLowerCase();
	const matched = entries
		.map((entry) => ({ entry, shape: networkUrlShape(entry.url) }))
		.filter(({ shape }) => needle === undefined || shape.toLowerCase().includes(needle))
		.sort((a, b) => a.entry.at - b.entry.at);
	if (!matched.length)
		return [entries.length ? `No request matches ${JSON.stringify(filter)}.` : "No requests captured on this page yet."];
	const shown = matched.slice(-limit);
	const lines = [
		`${shown.length} of ${matched.length} requests, oldest first. ${values ? "Values shown; credentials, held secrets and auth headers stay masked." : "Shape only: no values."}`,
	];
	for (const { entry, shape } of shown) {
		const outcome = entry.failed ? "failed" : entry.status === undefined ? "pending" : String(entry.status);
		lines.push(
			`- ${clock(entry.at)} ${entry.via} ${entry.method.toUpperCase()} ${values ? value(maskCredentialFields(entry.url.length >= PW_EXT_NETWORK_MAX_URL_CHARS ? `${entry.url}…` : entry.url)) : shape} → ${outcome}`,
			...headerLine("request headers", entry.requestHeaders, values, value),
			...(entry.request ? bodyLine("request body", entry.request, values, value) : []),
			...headerLine("response headers", entry.responseHeaders, values, value),
			...(entry.response ? bodyLine("response body", entry.response, values, value) : []),
		);
	}
	const newest = (shown.at(-1) as (typeof shown)[number]).entry.at;
	lines.push(`Newest request at ${newest}. Run pw --ext network --since ${newest} to see only later ones.`);
	return lines;
}
