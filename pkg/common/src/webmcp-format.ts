import { fail, requireFiniteNumber, requireOneOf, requireRecord, requireString } from "./assert";

export const WEBMCP_SCRIPT_MAX_BYTES = 262_144;
export const WEBMCP_MAX_SCRIPTS = 20;
export const WEBMCP_MAX_MATCHES = 10;

export const WEBMCP_SCRIPT_SOURCES = ["built-in", "paste", "file"] as const;
export type WebMcpScriptSource = (typeof WEBMCP_SCRIPT_SOURCES)[number];

export type WebMcpScriptRecord = {
	id: string;
	name: string;
	matches: string[];
	sha256: string;
	source: WebMcpScriptSource;
	enabled: boolean;
	approvedAt?: number;
};

export type BuiltInWebMcpScript = Pick<WebMcpScriptRecord, "id" | "name" | "matches"> & { enabledByDefault: boolean };

export const BUILT_IN_SCRIPTS = [
	{
		id: "outlook",
		name: "Outlook on the web",
		matches: ["https://outlook.office.com/*", "https://outlook.live.com/*"],
		enabledByDefault: false,
	},
] as const satisfies readonly BuiltInWebMcpScript[];

export type WebMcpApprovalClass = "read" | "session" | "each";

export const WEBMCP_TOOL_CLASSES = {
	dg_outlook_list: "read",
	dg_outlook_search: "read",
	dg_outlook_read: "read",
	dg_outlook_mark_read: "session",
	dg_outlook_flag: "session",
	dg_outlook_move: "session",
	dg_outlook_archive: "session",
	dg_outlook_draft: "session",
	dg_outlook_delete: "each",
	dg_outlook_reply: "each",
} as const satisfies Record<string, WebMcpApprovalClass>;

export const DG_TOOL_NAME = /^dg_[a-z0-9]+_[a-z0-9_]+$/;

export function isDgToolName(name: string): boolean {
	return DG_TOOL_NAME.test(name);
}

function patternCoversOrigin(pattern: string, origin: string): boolean {
	try {
		const { protocol, hostname } = new URL(origin);
		if (protocol !== "https:" || !pattern.startsWith("https://")) return false;
		const host = pattern.slice("https://".length).split("/")[0] ?? "";
		return host.startsWith("*.") ? hostname.endsWith(host.slice(1)) : hostname === host;
	} catch {
		return false;
	}
}

function builtInOwning(name: string) {
	return BUILT_IN_SCRIPTS.find((script) => name.startsWith(`dg_${script.id}_`));
}

/** True when an https match pattern's host covers the origin; the path part is ignored. */
export function matchesCoverOrigin(matches: readonly string[], origin: string): boolean {
	return matches.some((pattern) => patternCoversOrigin(pattern, origin));
}

function builtInCovers(owner: BuiltInWebMcpScript | undefined, origin: string): boolean {
	return owner !== undefined && matchesCoverOrigin(owner.matches, origin);
}

/** The approval class of a tool; with an origin, a dg_ tool keeps its table class only on the origins of the built-in script that owns its prefix. */
export function approvalClassOf(name: string, origin?: string): WebMcpApprovalClass | undefined {
	if (!name.startsWith("dg_")) return undefined;
	if (origin !== undefined && !builtInCovers(builtInOwning(name), origin)) return "each";
	return Object.hasOwn(WEBMCP_TOOL_CLASSES, name)
		? WEBMCP_TOOL_CLASSES[name as keyof typeof WEBMCP_TOOL_CLASSES]
		: "each";
}

/** True when the tool belongs to an enabled built-in script whose match patterns cover the origin. */
export function mailboxToolAllowed(name: string, origin: string, enabledBuiltInIds: ReadonlySet<string>): boolean {
	const owner = isDgToolName(name) ? builtInOwning(name) : undefined;
	return owner !== undefined && enabledBuiltInIds.has(owner.id) && builtInCovers(owner, origin);
}

const SCRIPT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MATCH_PATTERN =
	/^https:\/\/(?:\*\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)\/\S*$/;
const LOOPBACK_MATCH_PATTERN = /^http:\/\/(?:localhost|127\.0\.0\.1)\/\S*$/;
const RECORD_KEYS = ["id", "name", "matches", "sha256", "source", "enabled", "approvedAt"];

export function validateWebMcpScriptRecord(value: unknown): WebMcpScriptRecord {
	const path = "webmcp script";
	requireRecord(value, path);
	for (const key of Object.keys(value))
		if (!RECORD_KEYS.includes(key)) fail(`${path} has unknown field "${key}"`);
	requireString(value.id, `${path}.id`, { nonEmpty: true });
	if (!SCRIPT_ID.test(value.id)) fail(`${path}.id must be lowercase letters, digits and hyphens`);
	requireString(value.name, `${path}.name`, { nonEmpty: true });
	if (value.name.length > 100) fail(`${path}.name exceeds 100 characters`);
	if (!Array.isArray(value.matches) || value.matches.length === 0 || value.matches.length > WEBMCP_MAX_MATCHES)
		fail(`${path}.matches must hold 1 to ${WEBMCP_MAX_MATCHES} patterns`);
	for (const [index, match] of value.matches.entries()) {
		requireString(match, `${path}.matches[${index}]`);
		if (match.length > 200 || !(MATCH_PATTERN.test(match) || LOOPBACK_MATCH_PATTERN.test(match)))
			fail(`${path}.matches[${index}] must be an https://<host>/<path>, http://localhost/<path> or http://127.0.0.1/<path> match pattern`);
	}
	requireString(value.sha256, `${path}.sha256`);
	if (!SHA256.test(value.sha256)) fail(`${path}.sha256 must be 64 lowercase hex characters`);
	requireOneOf(value.source, `${path}.source`, WEBMCP_SCRIPT_SOURCES);
	if (typeof value.enabled !== "boolean") fail(`${path}.enabled must be a boolean`);
	if (value.approvedAt !== undefined) {
		requireFiniteNumber(value.approvedAt, `${path}.approvedAt`);
		if (value.approvedAt < 0) fail(`${path}.approvedAt must not be negative`);
	}
	return value as WebMcpScriptRecord;
}
