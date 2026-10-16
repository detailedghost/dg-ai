import {
	fail,
	isRecord,
	requireOneOf,
	requireRecord,
	requireString,
	requireStringArray,
} from "./assert";

/** Secret value storage limit measured in UTF-8 bytes. */
export const CREDENTIAL_MAX_VALUE_BYTES = 65_536;
/** Serialized metadata storage limit measured in UTF-8 bytes. */
export const CREDENTIAL_MAX_META_BYTES = 8_192;
/** Names follow `<consumer>/<provider>[/<qualifier>]`; only the charset is enforced. */
export const CREDENTIAL_NAME_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,127}$/;
/** Grant prefixes are the consumer segment of a credential name. */
export const CREDENTIAL_GRANT_PREFIX_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SECRET_LIKE_KEY = /value|secret|token|password/i;

/** Non-secret metadata; reserved fields are typed and any other JSON is allowed. */
export type CredentialMeta = {
	provider?: string;
	site?: string;
	scopes?: string[];
	expiresAt?: string;
	createdBy?: string;
	note?: string;
	[key: string]: unknown;
};
/** A decrypted credential; only the authenticated CLI frame may carry it. */
export type CredentialRecord = {
	value: string;
	meta: CredentialMeta;
	updatedAt: string;
};
/** List entry that never carries the secret value. */
export type CredentialSummary = {
	name: string;
	meta: CredentialMeta;
	updatedAt: string;
};
/** Grant entry that never carries the service token. */
export type CredentialGrantSummary = {
	prefix: string;
	createdAt: string;
	lastUsedAt: string | null;
};
/** Service-token proof that replaces a session for read-only access under one prefix. */
export type CredentialGrantAuth = { prefix: string; token: string };
/** Internal authenticated CLI operation; every request has a correlation ID. */
export type CredentialsCliRequest = {
	type: "cli-credentials-request";
	requestId: string;
	protocolVersion?: 1;
	operation:
		| "set"
		| "get"
		| "list"
		| "delete"
		| "grant"
		| "revoke"
		| "grant-list";
	name?: string;
	value?: string;
	meta?: CredentialMeta;
	prefix?: string;
	grant?: CredentialGrantAuth;
};
/** Daemon reply matched to the session/request pair; a get value must never be printed. */
export type CredentialsCliResult = {
	type: "cli-credentials-result";
	sessionId: string;
	requestId: string;
	ok: boolean;
	value?: unknown;
	error?: string;
};

function byteLength(value: string): number {
	return new TextEncoder().encode(value).length;
}

/** Validates the lowercase storage selector before it reaches SQL or AAD. */
export function validateCredentialName(value: unknown): string {
	if (typeof value !== "string" || !CREDENTIAL_NAME_PATTERN.test(value))
		fail(
			"credential name must be 1 to 128 lowercase letters, digits, dots, underscores, slashes or hyphens, starting with a letter or digit",
		);
	return value;
}

/** Validates the consumer prefix a service grant is scoped to. */
export function validateCredentialGrantPrefix(value: unknown): string {
	if (typeof value !== "string" || !CREDENTIAL_GRANT_PREFIX_PATTERN.test(value))
		fail(
			"credential grant prefix must be 1 to 64 lowercase letters, digits, dots, underscores or hyphens, starting with a letter or digit",
		);
	return value;
}

/** True when the name sits under `<prefix>/`. */
export function credentialNameInPrefix(name: string, prefix: string): boolean {
	return name.startsWith(`${prefix}/`);
}

function validateGrantAuth(value: unknown): void {
	requireRecord(value, "credentials CLI request.grant");
	for (const key of Object.keys(value))
		if (key !== "prefix" && key !== "token")
			fail(`credentials CLI request.grant.${key} is not supported`);
	validateCredentialGrantPrefix(value.prefix);
	if (
		typeof value.token !== "string" ||
		!value.token ||
		byteLength(value.token) > 128
	)
		fail("credentials CLI request.grant.token must be a string of at most 128 bytes");
}

/** Accepts a non-empty secret within the byte limit; failures never echo it. */
export function validateCredentialValue(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		byteLength(value) > CREDENTIAL_MAX_VALUE_BYTES
	)
		fail(
			`credential value must be a non-empty string of at most ${CREDENTIAL_MAX_VALUE_BYTES} bytes`,
		);
	return value;
}

function rejectSecretKeys(value: unknown, path: string): void {
	if (Array.isArray(value)) {
		value.forEach((entry, i) => rejectSecretKeys(entry, `${path}[${i}]`));
		return;
	}
	if (!isRecord(value)) return;
	for (const [key, entry] of Object.entries(value)) {
		if (SECRET_LIKE_KEY.test(key))
			fail(
				`${path}.${key} looks secret; store secrets only as the credential value`,
			);
		rejectSecretKeys(entry, `${path}.${key}`);
	}
}

/** Validates non-secret metadata and rejects keys named like value, secret, token or password. */
export function validateCredentialMeta(value: unknown): CredentialMeta {
	requireRecord(value, "credential meta");
	rejectSecretKeys(value, "credential meta");
	for (const key of ["provider", "site", "createdBy", "note"] as const)
		if (value[key] !== undefined)
			requireString(value[key], `credential meta.${key}`);
	if (value.scopes !== undefined)
		requireStringArray(value.scopes, "credential meta.scopes");
	if (value.expiresAt !== undefined) {
		requireString(value.expiresAt, "credential meta.expiresAt");
		if (Number.isNaN(Date.parse(value.expiresAt)))
			fail("credential meta.expiresAt must be an ISO 8601 timestamp");
	}
	if (byteLength(JSON.stringify(value)) > CREDENTIAL_MAX_META_BYTES)
		fail(`credential meta exceeds ${CREDENTIAL_MAX_META_BYTES} bytes`);
	return value as CredentialMeta;
}

/** Validates correlation and operation-specific input for the credentials frame. */
export function validateCredentialsCliRequest(
	value: unknown,
): CredentialsCliRequest {
	requireRecord(value, "credentials CLI request");
	requireOneOf(value.type, "credentials CLI request.type", [
		"cli-credentials-request",
	]);
	const fields = {
		set: ["name", "value", "meta"],
		get: ["name"],
		list: [],
		delete: ["name"],
		grant: ["prefix"],
		revoke: ["prefix"],
		"grant-list": [],
	};
	requireOneOf(value.operation, "credentials CLI request.operation", [
		"set",
		"get",
		"list",
		"delete",
		"grant",
		"revoke",
		"grant-list",
	]);
	const allowed = [
		"type",
		"requestId",
		"operation",
		"protocolVersion",
		"grant",
		...fields[value.operation],
	];
	for (const key of Object.keys(value))
		if (value[key] !== undefined && !allowed.includes(key))
			fail(`credentials CLI request.${key} is not supported`);
	if (
		typeof value.requestId !== "string" ||
		!value.requestId.trim() ||
		byteLength(value.requestId) > 128
	)
		fail(
			"credentials CLI request.requestId must be a non-empty string of at most 128 bytes",
		);
	if (value.protocolVersion !== undefined && value.protocolVersion !== 1)
		fail("credentials CLI request.protocolVersion must be 1");
	if (value.grant !== undefined) validateGrantAuth(value.grant);
	if (["set", "get", "delete"].includes(value.operation))
		validateCredentialName(value.name);
	if (value.operation === "grant" || value.operation === "revoke")
		validateCredentialGrantPrefix(value.prefix);
	if (value.operation === "set") {
		validateCredentialValue(value.value);
		validateCredentialMeta(value.meta);
	}
	return value as CredentialsCliRequest;
}
