import { fail, requireRecord } from "./assert";

export const INBOX_MAX_PAGE_SIZE = 200;
export const INBOX_MAX_MESSAGE_IDS = 200;
export const INBOX_MAX_CACHE_BYTES = 524_288;
export const INBOX_MAX_TIMEOUT_MS = 120_000;
export const INBOX_DEFAULT_TIMEOUT_MS = 30_000;
export type InboxProvider = "protonmail" | "gmail" | "outlook";

export type InboxProviderSettings = {
	clientId?: string;
	clientSecretEnv?: string;
	accessTokenEnv?: string;
	refreshTokenEnv?: string;
	authMode?: "browser" | "device-code" | "env" | "silent";
	redirectUri?: string;
	scopes?: string[];
	pageSize?: number;
	tenantId?: string;
	authority?: string;
	loginHint?: string;
};
export type InboxProfile = {
	provider: InboxProvider;
	accountHint?: string;
	tabId?: number;
	gmail?: InboxProviderSettings;
	outlook?: InboxProviderSettings;
};
export type InboxProfileSummary = { name: string; provider: InboxProvider };
export type InboxBrowserOperation =
	| "list-folders"
	| "list-filters"
	| "list-messages"
	| "create-folder"
	| "create-filter"
	| "update-filter"
	| "delete-filter"
	| "move-messages"
	| "mark-read"
	| "unlabel-messages";
export type InboxBrowserRequest = {
	operation: InboxBrowserOperation;
	tabId?: number;
	accountHint?: string;
	page?: number;
	pageSize?: number;
	folderId?: string;
	messageIds?: string[];
	targetFolderId?: string;
	labelId?: string;
	id?: string;
	name?: string;
	sieve?: string;
	enabled?: boolean;
	type?: "folder" | "label";
};
export type InboxFolder = {
	id: string;
	name: string;
	type?: "folder" | "label" | "system";
	path?: string;
	parentId?: string;
	total?: number;
	unread?: number;
	aliases?: string[];
};
export type InboxFilter = {
	id: string;
	name: string;
	enabled: boolean;
	conditions: string[];
	actions: string[];
	sequence?: number;
};
export type InboxMessage = {
	id: string;
	from: string;
	fromDomain?: string;
	senderName?: string;
	subject: string;
	snippet: string;
	folderId: string;
	folderName?: string;
	read?: boolean;
	isRead?: boolean;
	receivedAt?: string;
	categories?: string[];
	labels?: string[];
	threadId?: string;
};
export type InboxBrowserResponse = {
	folders?: InboxFolder[];
	filters?: InboxFilter[];
	messages?: InboxMessage[];
	folder?: InboxFolder;
	filter?: InboxFilter;
	hasMore?: boolean;
};
export type InboxCliRequest = {
	type: "cli-inbox-request";
	requestId: string;
	protocolVersion?: 1;
	operation:
		| "profile-get"
		| "profile-set"
		| "profile-list"
		| "cache-get"
		| "cache-set"
		| "browser";
	name?: string;
	provider?: InboxProvider;
	profile?: InboxProfile;
	cache?: string;
	request?: InboxBrowserRequest;
	timeoutMs?: number;
};
export type InboxCliResult = {
	type: "cli-inbox-result";
	sessionId: string;
	requestId: string;
	ok: boolean;
	value?: unknown;
	error?: string;
};

function object(
	value: unknown,
	path: string,
	allowed: readonly string[],
): Record<string, unknown> {
	requireRecord(value, path);
	for (const key of Object.keys(value))
		if (value[key] !== undefined && !allowed.includes(key))
			fail(`${path}.${key} is not supported`);
	return value;
}
function text(
	value: unknown,
	path: string,
	max = 1024,
	empty = false,
): asserts value is string {
	if (
		typeof value !== "string" ||
		(!empty && !value.trim()) ||
		new TextEncoder().encode(value).length > max
	) {
		fail(
			`${path} must be ${empty ? "a" : "a non-empty"} string of at most ${max} bytes`,
		);
	}
}
function integer(
	value: unknown,
	path: string,
	min: number,
	max: number,
): asserts value is number {
	if (
		!Number.isSafeInteger(value) ||
		(value as number) < min ||
		(value as number) > max
	)
		fail(`${path} must be an integer between ${min} and ${max}`);
}
function choice(
	value: unknown,
	path: string,
	allowed: readonly string[],
): void {
	if (!allowed.includes(value as string))
		fail(`${path} must be one of ${allowed.join(", ")}`);
}
function strings(
	value: unknown,
	path: string,
	max: number,
	maxBytes = 1024,
	min = 0,
): void {
	if (!Array.isArray(value) || value.length < min || value.length > max)
		fail(`${path} must be an array of ${min} to ${max} strings`);
	value.forEach((entry, i) => text(entry, `${path}[${i}]`, maxBytes));
}
function optionalText(
	obj: Record<string, unknown>,
	keys: string[],
	path: string,
	max = 1024,
): void {
	for (const key of keys)
		if (obj[key] !== undefined) text(obj[key], `${path}.${key}`, max);
}
export function validateInboxProvider(value: unknown): InboxProvider {
	choice(value, "inbox provider", ["protonmail", "gmail", "outlook"]);
	return value as InboxProvider;
}
export function validateInboxProfileName(value: unknown): string {
	text(value, "inbox profile name", 128);
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value))
		fail(
			"inbox profile name must use letters, numbers, dots, underscores or hyphens",
		);
	return value;
}
export function validateInboxAuthCache(value: unknown): string {
	text(value, "inbox OAuth cache", INBOX_MAX_CACHE_BYTES, true);
	return value;
}
function settings(value: unknown, provider: "gmail" | "outlook"): void {
	const path = `inbox profile.${provider}`;
	const v = object(value, path, [
		"clientId",
		"clientSecretEnv",
		"accessTokenEnv",
		"refreshTokenEnv",
		"authMode",
		"redirectUri",
		"scopes",
		"pageSize",
		...(provider === "outlook" ? ["tenantId", "authority", "loginHint"] : []),
	]);
	optionalText(
		v,
		["clientId", "redirectUri", "tenantId", "authority", "loginHint"],
		path,
		2048,
	);
	for (const key of ["clientSecretEnv", "accessTokenEnv", "refreshTokenEnv"]) {
		if (v[key] === undefined) continue;
		text(v[key], `${path}.${key}`, 128);
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v[key] as string))
			fail(`${path}.${key} must name an environment variable`);
	}
	if (v.authMode !== undefined)
		choice(
			v.authMode,
			`${path}.authMode`,
			provider === "gmail"
				? ["browser", "device-code", "env"]
				: ["browser", "device-code", "silent", "env"],
		);
	if (v.pageSize !== undefined)
		integer(
			v.pageSize,
			`${path}.pageSize`,
			1,
			provider === "gmail" ? 500 : 200,
		);
	if (v.scopes !== undefined) strings(v.scopes, `${path}.scopes`, 32, 2048);
}
export function validateInboxProfile(value: unknown): InboxProfile {
	const v = object(value, "inbox profile", [
		"provider",
		"accountHint",
		"tabId",
		"gmail",
		"outlook",
	]);
	validateInboxProvider(v.provider);
	optionalText(v, ["accountHint"], "inbox profile", 320);
	if (v.tabId !== undefined)
		integer(v.tabId, "inbox profile.tabId", 0, 2_147_483_647);
	if (v.gmail !== undefined) settings(v.gmail, "gmail");
	if (v.outlook !== undefined) settings(v.outlook, "outlook");
	return value as InboxProfile;
}
export function validateInboxBrowserRequest(
	value: unknown,
): InboxBrowserRequest {
	requireRecord(value, "inbox browser request");
	const operations: Record<InboxBrowserOperation, string[]> = {
		"list-folders": [],
		"list-filters": [],
		"list-messages": ["page", "pageSize", "folderId"],
		"create-folder": ["name", "type"],
		"create-filter": ["name", "sieve", "enabled"],
		"update-filter": ["id", "name", "sieve", "enabled"],
		"delete-filter": ["id"],
		"move-messages": ["messageIds", "targetFolderId"],
		"mark-read": ["messageIds"],
		"unlabel-messages": ["messageIds", "labelId"],
	};
	choice(
		value.operation,
		"inbox browser request.operation",
		Object.keys(operations),
	);
	const operation = value.operation as InboxBrowserOperation;
	const v = object(value, "inbox browser request", [
		"operation",
		"tabId",
		"accountHint",
		...operations[operation],
	]);
	optionalText(
		v,
		["accountHint", "folderId", "targetFolderId", "labelId", "id", "name"],
		"inbox browser request",
	);
	if (v.tabId !== undefined)
		integer(v.tabId, "inbox browser request.tabId", 0, 2_147_483_647);
	if (v.page !== undefined)
		integer(v.page, "inbox browser request.page", 0, 1_000_000);
	if (v.pageSize !== undefined)
		integer(
			v.pageSize,
			"inbox browser request.pageSize",
			1,
			INBOX_MAX_PAGE_SIZE,
		);
	if (v.sieve !== undefined)
		text(v.sieve, "inbox browser request.sieve", 65_536, true);
	if (v.enabled !== undefined && typeof v.enabled !== "boolean")
		fail("inbox browser request.enabled must be a boolean");
	if (v.type !== undefined)
		choice(v.type, "inbox browser request.type", ["folder", "label"]);
	if (["move-messages", "mark-read", "unlabel-messages"].includes(operation))
		strings(
			v.messageIds,
			"inbox browser request.messageIds",
			INBOX_MAX_MESSAGE_IDS,
			1024,
			1,
		);
	if (operation === "move-messages")
		text(v.targetFolderId, "inbox browser request.targetFolderId");
	if (operation === "unlabel-messages")
		text(v.labelId, "inbox browser request.labelId");
	if (["update-filter", "delete-filter"].includes(operation))
		text(v.id, "inbox browser request.id");
	if (["create-folder", "create-filter"].includes(operation))
		text(v.name, "inbox browser request.name");
	return value as InboxBrowserRequest;
}
function folder(value: unknown): void {
	const v = object(value, "inbox folder", [
		"id",
		"name",
		"type",
		"path",
		"parentId",
		"total",
		"unread",
		"aliases",
	]);
	text(v.id, "inbox folder.id");
	text(v.name, "inbox folder.name");
	optionalText(v, ["path", "parentId"], "inbox folder");
	if (v.type !== undefined)
		choice(v.type, "inbox folder.type", ["folder", "label", "system"]);
	for (const key of ["total", "unread"])
		if (v[key] !== undefined)
			integer(v[key], `inbox folder.${key}`, 0, Number.MAX_SAFE_INTEGER);
	if (v.aliases !== undefined) strings(v.aliases, "inbox folder.aliases", 64);
}
function filter(value: unknown): void {
	const v = object(value, "inbox filter", [
		"id",
		"name",
		"enabled",
		"conditions",
		"actions",
		"sequence",
	]);
	text(v.id, "inbox filter.id");
	text(v.name, "inbox filter.name");
	if (typeof v.enabled !== "boolean")
		fail("inbox filter.enabled must be a boolean");
	strings(v.conditions, "inbox filter.conditions", 200, 65_536);
	strings(v.actions, "inbox filter.actions", 200, 65_536);
	if (v.sequence !== undefined)
		integer(v.sequence, "inbox filter.sequence", 0, Number.MAX_SAFE_INTEGER);
}
function message(value: unknown): void {
	const v = object(value, "inbox message", [
		"id",
		"from",
		"fromDomain",
		"senderName",
		"subject",
		"snippet",
		"folderId",
		"folderName",
		"read",
		"isRead",
		"receivedAt",
		"categories",
		"labels",
		"threadId",
	]);
	for (const key of ["id", "folderId"]) text(v[key], `inbox message.${key}`);
	for (const key of ["from", "subject", "snippet"])
		text(v[key], `inbox message.${key}`, key === "snippet" ? 4096 : 2048, true);
	optionalText(
		v,
		["fromDomain", "senderName", "folderName", "receivedAt", "threadId"],
		"inbox message",
	);
	for (const key of ["read", "isRead"])
		if (v[key] !== undefined && typeof v[key] !== "boolean")
			fail(`inbox message.${key} must be a boolean`);
	for (const key of ["categories", "labels"])
		if (v[key] !== undefined) strings(v[key], `inbox message.${key}`, 100);
}
export function validateInboxBrowserResponse(
	value: unknown,
): InboxBrowserResponse {
	const v = object(value, "inbox browser response", [
		"folders",
		"filters",
		"messages",
		"folder",
		"filter",
		"hasMore",
	]);
	for (const [key, validate, max] of [
		["folders", folder, 2000],
		["filters", filter, 1000],
		["messages", message, INBOX_MAX_PAGE_SIZE],
	] as const) {
		if (v[key] === undefined) continue;
		if (!Array.isArray(v[key]) || v[key].length > max)
			fail(
				`inbox browser response.${key} must be an array of at most ${max} items`,
			);
		v[key].forEach(validate);
	}
	if (v.folder !== undefined) folder(v.folder);
	if (v.filter !== undefined) filter(v.filter);
	if (v.hasMore !== undefined && typeof v.hasMore !== "boolean")
		fail("inbox browser response.hasMore must be a boolean");
	if (new TextEncoder().encode(JSON.stringify(value)).length > 786_432)
		fail("inbox browser response exceeds 786432 bytes");
	return value as InboxBrowserResponse;
}
export function validateInboxCliRequest(value: unknown): InboxCliRequest {
	requireRecord(value, "inbox CLI request");
	choice(value.type, "inbox CLI request.type", ["cli-inbox-request"]);
	const fields = {
		"profile-get": ["name"],
		"profile-set": ["name", "profile"],
		"profile-list": [],
		"cache-get": ["name", "provider"],
		"cache-set": ["name", "provider", "cache"],
		browser: ["request"],
	};
	choice(value.operation, "inbox CLI request.operation", Object.keys(fields));
	const operation = value.operation as InboxCliRequest["operation"];
	const v = object(value, "inbox CLI request", [
		"type",
		"requestId",
		"operation",
		"timeoutMs",
		"protocolVersion",
		...fields[operation],
	]);
	text(v.requestId, "inbox CLI request.requestId", 128);
	if (v.protocolVersion !== undefined)
		integer(v.protocolVersion, "inbox CLI request.protocolVersion", 1, 1);
	if (v.timeoutMs !== undefined)
		integer(
			v.timeoutMs,
			"inbox CLI request.timeoutMs",
			1,
			INBOX_MAX_TIMEOUT_MS,
		);
	if (operation === "browser") validateInboxBrowserRequest(v.request);
	else if (operation !== "profile-list") validateInboxProfileName(v.name);
	if (operation === "profile-set") validateInboxProfile(v.profile);
	if (operation.startsWith("cache-")) validateInboxProvider(v.provider);
	if (operation === "cache-set") validateInboxAuthCache(v.cache);
	return value as InboxCliRequest;
}
