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
/** Prefixes that dg tools own; a job cannot take one as its credential prefix. */
export const RESERVED_CREDENTIAL_PREFIXES = [
	"pw",
	"extension",
	"phone-friend",
	"phone-vault",
	"db",
	"dg",
] as const;
/** The daemon-held key that signs plugin approvals; it never leaves the daemon. */
export const APPROVAL_KEY_CREDENTIAL = "dg/plugin-approval-key";
export type ApprovalPurpose = "approval" | "statcache";
/** Field count the daemon expects per purpose; it prepends the purpose's domain string itself. */
export const APPROVAL_FIELD_COUNTS: Record<ApprovalPurpose, number> = { approval: 7, statcache: 3 };
export const APPROVAL_FIELD_MAX_BYTES = 8_192;
/** Shape of an approval MAC: 64 lowercase hex characters. */
export const APPROVAL_MAC = /^[0-9a-f]{64}$/;
const INJECTION_ENV =
	/^(?:LD_|DYLD_|_RLD|MALLOC_|GCONV_PATH$|NODE_OPTIONS$|NODE_PATH$|NODE_EXTRA_CA_CERTS$|BUN_|PYTHON|PERL5|PERLLIB$|RUBY|LUA_|TCL|R_PROFILE|R_ENVIRON|BASH_ENV$|ENV$|ZDOTDIR$|PS4$|SHELLOPTS$|BASHOPTS$|PROMPT_COMMAND$|JAVA_TOOL_OPTIONS$|_JAVA_OPTIONS$|JDK_JAVA_OPTIONS$|CLASSPATH$|GIT_|SSH_ASKPASS$|EDITOR$|VISUAL$|PAGER$|LESSOPEN$|PATH$|HOME$|XDG_CONFIG_HOME$|CURL_HOME$|CURL_CA_BUNDLE$|HTTPS?_PROXY$|ALL_PROXY$|NO_PROXY$|SSL_CERT_FILE$|SSL_CERT_DIR$|REQUESTS_CA_BUNDLE$|WGETRC$|GLIBC_TUNABLES$|OPENSSL_CONF$|OPENSSL_ENGINES$|SSLKEYLOGFILE$|NODE_TLS_REJECT_UNAUTHORIZED$|IFS$|HOSTALIASES$|LOCPATH$|NLSPATH$|NPM_CONFIG_)/i;

/** True for a variable that can change how a program loads code or finds its tools. */
export const isInjectionEnvName = (name: string): boolean => INJECTION_ENV.test(name);

const SECRET_LIKE_KEY = /value|secret|token|password/i;
export const SECRET_PAGE_PATH = "/secret";
export const SECRET_INTAKE_PATH = "/secret-intake";
export const SECRET_CODE_KEY = "code";
export const SECRET_CODE_HEADER = "X-Dg-Secret-Code";

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
		| "grant-list"
		| "exec"
		| "intake"
		| "approval-sign"
		| "approval-verify";
	name?: string;
	purpose?: ApprovalPurpose;
	fields?: string[];
	mac?: string;
	exec?: CredentialExecSpec;
	value?: string;
	meta?: CredentialMeta;
	prefix?: string;
	grant?: CredentialGrantAuth;
};
/** Where a human types one credential value; the page url carries a single-use code and never a session token. */
export type CredentialIntake = { url: string; expiresAt: string };
/** A command that dg daemon runs with stored values in env vars; the CLI never receives the values. */
export type CredentialExecSpec = {
	bindings: { name: string; env: string }[];
	argv: string[];
	cwd: string;
	env: Record<string, string>;
};
/** One scrubbed chunk of the output of a command that dg daemon runs for exec. */
export type CredentialsExecOutput = {
	type: "cli-credentials-exec-output";
	sessionId: string;
	requestId: string;
	stream: "stdout" | "stderr";
	data: string;
};
export const CREDENTIAL_EXEC_MAX_BINDINGS = 16;
export const CREDENTIAL_EXEC_MAX_ARGS = 256;
export const CREDENTIAL_EXEC_MAX_BYTES = 262_144;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** Names under this prefix are refused to session get; only exec and list reach them. */
export const CREDENTIAL_SEALED_PREFIX = "pw";

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

const CREDENTIAL_NAME_RULE =
	"credential name must be 1 to 128 letters, digits, dots, underscores, slashes or hyphens, starting with a letter or digit";
const CREDENTIAL_GRANT_PREFIX_RULE =
	"credential grant prefix must be 1 to 64 letters, digits, dots, underscores or hyphens, starting with a letter or digit";

/** Folds letters to lowercase, then checks the storage selector before it reaches SQL or AAD. */
export function validateCredentialName(value: unknown): string {
	if (typeof value !== "string") fail(CREDENTIAL_NAME_RULE);
	const name = value.toLowerCase();
	if (!CREDENTIAL_NAME_PATTERN.test(name)) fail(CREDENTIAL_NAME_RULE);
	return name;
}

/** Folds letters to lowercase, then checks the consumer prefix a service grant is scoped to. */
export function validateCredentialGrantPrefix(value: unknown): string {
	if (typeof value !== "string") fail(CREDENTIAL_GRANT_PREFIX_RULE);
	const prefix = value.toLowerCase();
	if (!CREDENTIAL_GRANT_PREFIX_PATTERN.test(prefix)) fail(CREDENTIAL_GRANT_PREFIX_RULE);
	return prefix;
}

/** True when the name sits under `<prefix>/`, ignoring letter case. */
export function credentialNameInPrefix(name: string, prefix: string): boolean {
	return name.toLowerCase().startsWith(`${prefix.toLowerCase()}/`);
}

/** True when the prefix is one that a dg tool owns, ignoring letter case. */
export function isReservedCredentialPrefix(prefix: string): boolean {
	return (RESERVED_CREDENTIAL_PREFIXES as readonly string[]).includes(
		prefix.toLowerCase(),
	);
}

function validateGrantAuth(value: unknown): void {
	requireRecord(value, "credentials CLI request.grant");
	for (const key of Object.keys(value))
		if (key !== "prefix" && key !== "token")
			fail(`credentials CLI request.grant.${key} is not supported`);
	value.prefix = validateCredentialGrantPrefix(value.prefix);
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
		exec: ["exec"],
		intake: ["name", "meta"],
		"approval-sign": ["purpose", "fields"],
		"approval-verify": ["purpose", "fields", "mac"],
	};
	requireOneOf(value.operation, "credentials CLI request.operation", [
		"set",
		"get",
		"list",
		"delete",
		"grant",
		"revoke",
		"grant-list",
		"exec",
		"intake",
		"approval-sign",
		"approval-verify",
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
	if (["set", "get", "delete", "intake"].includes(value.operation))
		value.name = validateCredentialName(value.name);
	if (value.operation === "grant" || value.operation === "revoke")
		value.prefix = validateCredentialGrantPrefix(value.prefix);
	if (value.operation === "set") {
		validateCredentialValue(value.value);
		validateCredentialMeta(value.meta);
	}
	if (value.operation === "intake") validateCredentialMeta(value.meta);
	if (value.operation === "exec") validateExecSpec(value.exec);
	if (value.operation === "approval-sign" || value.operation === "approval-verify") validateApprovalInput(value);
	return value as CredentialsCliRequest;
}

function validateExecSpec(value: unknown): void {
	const path = "credentials CLI request.exec";
	requireRecord(value, path);
	for (const key of Object.keys(value))
		if (!["bindings", "argv", "cwd", "env"].includes(key)) fail(`${path}.${key} is not supported`);
	if (!Array.isArray(value.bindings) || value.bindings.length === 0 || value.bindings.length > CREDENTIAL_EXEC_MAX_BINDINGS)
		fail(`${path}.bindings must hold 1 to ${CREDENTIAL_EXEC_MAX_BINDINGS} entries`);
	for (const binding of value.bindings as unknown[]) {
		requireRecord(binding, `${path}.bindings[]`);
		binding.name = validateCredentialName(binding.name);
		if (typeof binding.env !== "string" || !ENV_NAME.test(binding.env))
			fail(`${path}.bindings[].env must be an environment variable name`);
	}
	requireStringArray(value.argv, `${path}.argv`);
	if ((value.argv as string[]).length === 0 || (value.argv as string[]).length > CREDENTIAL_EXEC_MAX_ARGS)
		fail(`${path}.argv must hold 1 to ${CREDENTIAL_EXEC_MAX_ARGS} arguments`);
	requireString(value.cwd, `${path}.cwd`, { nonEmpty: true });
	if (!/^(\/|[A-Za-z]:[\\/])/.test(value.cwd as string)) fail(`${path}.cwd must be an absolute path`);
	requireRecord(value.env, `${path}.env`);
	for (const [key, entry] of Object.entries(value.env))
		if (!ENV_NAME.test(key) || typeof entry !== "string") fail(`${path}.env must map names to strings`);
	if (byteLength(JSON.stringify(value)) > CREDENTIAL_EXEC_MAX_BYTES) fail(`${path} exceeds ${CREDENTIAL_EXEC_MAX_BYTES} bytes`);
}

function validateApprovalInput(value: Record<string, unknown>): void {
	const path = "credentials CLI request";
	requireOneOf(value.purpose, `${path}.purpose`, ["approval", "statcache"]);
	const count = APPROVAL_FIELD_COUNTS[value.purpose];
	const fields = value.fields;
	if (!Array.isArray(fields) || fields.length !== count)
		fail(`${path}.fields must hold exactly ${count} strings for ${value.purpose}`);
	for (const field of fields) {
		if (typeof field !== "string" || field.includes("\0") || byteLength(field) > APPROVAL_FIELD_MAX_BYTES)
			fail(`${path}.fields must hold strings with no NUL byte and at most ${APPROVAL_FIELD_MAX_BYTES} bytes each`);
	}
	if (value.operation === "approval-verify" && (typeof value.mac !== "string" || !APPROVAL_MAC.test(value.mac)))
		fail(`${path}.mac must be 64 lowercase hex characters`);
}
