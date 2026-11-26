import { parse } from "smol-toml";
import { CREDENTIAL_NAME_PATTERN } from "../credentials-format";
import { DgCliError } from "../errors";
import { lineOfKey } from "../node/dg-toml";
import { pluginTokenCredential } from "./contract";

export const PLUGIN_KINDS = ["hook", "job", "skill"] as const;
export const PLUGIN_TRANSPORTS = ["ipc", "http", "tcp", "udp"] as const;

export type PluginKind = (typeof PLUGIN_KINDS)[number];
export type PluginTransport = (typeof PLUGIN_TRANSPORTS)[number];

export type PluginEntryPoint = { builtin: string } | { command: string; args: string[] };

export type PluginManifest = {
	name: string;
	version: string;
	kind: PluginKind;
	transport: PluginTransport;
	endpoint?: string;
	remote: boolean;
	source?: string;
	pin?: { kind: "sha256" | "commit"; value: string };
	entry: PluginEntryPoint;
	capabilities: { network: boolean; fs_read: string[]; fs_write: string[]; exec: string[] };
	permissions: { credentials: string[]; env: string[] };
};

type Table = Record<string, unknown>;
type Where = { file: string; text: string };

const TCP_TOKEN_PROBLEM = 'tcp would send the plugin token to any local listener; use transport = "ipc", or the http transport with an https endpoint';

const ROOT_KEYS = ["name", "version", "kind", "transport", "endpoint", "remote", "source", "sha256", "commit", "entry", "capabilities", "permissions"];
const NAME = /^[a-z][a-z0-9-]{0,63}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const HOST_PORT = /^(\[[^\]]+\]|[^:\s/]+):(\d{1,5})$/;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function fail(where: Where, key: string, message: string): never {
	const target = key === "" ? "the file" : key;
	throw new DgCliError(`dg plugin: ${where.file}:${lineOfKey(where.text, key)}: ${message}. Next: fix ${target} in ${where.file}, then run dg plugin verify.`);
}

function isTable(value: unknown): value is Table {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function table(where: Where, key: string, value: unknown): Table {
	if (value === undefined) return {};
	if (!isTable(value)) fail(where, key, `${key} must be a table`);
	return value;
}

function onlyKeys(where: Where, prefix: string, value: Table, allowed: readonly string[]): void {
	for (const name of Object.keys(value))
		if (!allowed.includes(name)) fail(where, prefix ? `${prefix}.${name}` : name, `${prefix ? `${prefix}.` : ""}${name} is not a plugin.toml key; the keys are ${allowed.join(", ")}`);
}

function optionalString(where: Where, key: string, value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length === 0) fail(where, key, `${key} must be a non-empty string`);
	return value;
}

function requiredString(where: Where, key: string, value: unknown): string {
	const text = optionalString(where, key, value);
	if (text === undefined) fail(where, key, `${key} is required`);
	return text;
}

function stringList(where: Where, key: string, value: unknown): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) fail(where, key, `${key} must be a list of strings`);
	return value as string[];
}

function oneOf<T extends string>(where: Where, key: string, value: unknown, allowed: readonly T[], fallback?: T): T {
	if (value === undefined && fallback !== undefined) return fallback;
	if (typeof value !== "string" || !(allowed as readonly string[]).includes(value))
		fail(where, key, `${key} must be one of ${allowed.join(", ")}, got ${JSON.stringify(value)}`);
	return value as T;
}

function entryPoint(where: Where, raw: unknown): PluginEntryPoint {
	if (raw === undefined) fail(where, "entry", "entry is required: add an [entry] table with builtin or command");
	const entry = table(where, "entry", raw);
	onlyKeys(where, "entry", entry, ["builtin", "command", "args"]);
	const builtin = optionalString(where, "entry.builtin", entry.builtin);
	const command = optionalString(where, "entry.command", entry.command);
	if ((builtin === undefined) === (command === undefined)) fail(where, "entry", "entry must set exactly one of builtin or command");
	if (builtin !== undefined) {
		if (entry.args !== undefined) fail(where, "entry.args", "entry.args needs entry.command");
		return { builtin };
	}
	return { command: command as string, args: stringList(where, "entry.args", entry.args) };
}

function parseHostPort(where: Where, transport: PluginTransport, endpoint: string): string {
	const match = HOST_PORT.exec(endpoint);
	const port = Number(match?.[2]);
	if (!match || port < 1 || port > 65535) fail(where, "endpoint", `endpoint must be host:port for the ${transport} transport, got ${endpoint}`);
	return match[1] as string;
}

export type EndpointProblem = { problem: string; next: string };

const NOT_HTTP_URL: EndpointProblem = {
	problem: "endpoint must be an http or https URL",
	next: "set endpoint to an http or https URL in plugin.toml",
};

/** The first rule an http endpoint breaks, or undefined; the one policy for the manifest and the transport. */
export function checkHttpEndpoint(endpoint: string, remote: boolean, plugin: string): EndpointProblem | undefined {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		return NOT_HTTP_URL;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return NOT_HTTP_URL;
	if (url.username !== "" || url.password !== "")
		return {
			problem: "endpoint must not hold credentials in the endpoint URL; use the plugin token from dg credentials",
			next: `remove the credentials from endpoint in plugin.toml, then run dg credentials set ${pluginTokenCredential(plugin)}`,
		};
	if (remote) {
		if (url.protocol === "https:") return undefined;
		return { problem: "a remote endpoint must use https", next: "use an https endpoint in plugin.toml" };
	}
	if (LOOPBACK_HOSTS.has(url.hostname)) return undefined;
	return {
		problem: `endpoint host ${url.hostname} is not loopback`,
		next: "set remote = true in plugin.toml and allow_remote = true in config.toml, or use a loopback endpoint",
	};
}

function checkEndpoint(where: Where, name: string, transport: PluginTransport, remote: boolean, endpoint: string | undefined): void {
	if (transport === "ipc") {
		if (remote) fail(where, "remote", "remote needs the http transport with an https endpoint");
		return;
	}
	if (endpoint === undefined) fail(where, "transport", `endpoint is required for the ${transport} transport`);
	if (transport === "http") {
		const found = checkHttpEndpoint(endpoint, remote, name);
		if (found !== undefined) fail(where, "endpoint", `${found.problem}; ${found.next}`);
		return;
	}
	if (remote) fail(where, "remote", "remote needs the http transport with an https endpoint");
	const host = parseHostPort(where, transport, endpoint);
	if (!LOOPBACK_HOSTS.has(host)) fail(where, "endpoint", `endpoint host ${host} is not loopback; ${transport} plugins are local only, use the http transport with remote = true`);
}

function pinOf(where: Where, root: Table, kind: PluginKind, source: string | undefined): PluginManifest["pin"] {
	const sha256 = optionalString(where, "sha256", root.sha256);
	const commit = optionalString(where, "commit", root.commit);
	if (sha256 !== undefined && commit !== undefined) fail(where, "commit", "set only one of sha256 or commit");
	if (sha256 !== undefined) {
		if (kind === "job") fail(where, "sha256", "a job plugin must be pinned by a full commit SHA (commit = 40 or 64 lowercase hex), not by sha256");
		if (!SHA256.test(sha256)) fail(where, "sha256", "sha256 must be 64 hex characters");
		return { kind: "sha256", value: sha256 };
	}
	if (commit !== undefined) {
		if (!COMMIT.test(commit)) fail(where, "commit", "commit must be 40 or 64 hex characters");
		return { kind: "commit", value: commit };
	}
	if (kind === "job" && source !== undefined) fail(where, "commit", "a job plugin with a source must be pinned by a full commit SHA (commit = 40 or 64 lowercase hex)");
	if (kind === "skill" || source !== undefined) fail(where, "sha256", "a skill or a plugin with a source must be pinned by sha256 or commit");
	return undefined;
}

function syntaxLine(error: unknown): number {
	const line = (error as { line?: unknown }).line;
	return typeof line === "number" && line > 0 ? line : 1;
}

/** Parses and checks a plugin.toml text, naming `file` in each error. */
export function parseManifest(text: string, file: string): PluginManifest {
	const where = { file, text };
	let raw: unknown;
	try {
		raw = parse(text);
	} catch (error) {
		const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
		throw new DgCliError(`dg plugin: ${file}:${syntaxLine(error)}: plugin.toml is not valid TOML: ${reason}. Next: fix the line, then run dg plugin verify.`);
	}
	const root = table(where, "plugin.toml", raw);
	onlyKeys(where, "", root, ROOT_KEYS);
	const name = requiredString(where, "name", root.name);
	if (!NAME.test(name)) fail(where, "name", "name must be lowercase letters, digits and hyphens, starting with a letter");
	const version = requiredString(where, "version", root.version);
	if (!SEMVER.test(version)) fail(where, "version", `version must be a semantic version like 1.2.3, got ${version}`);
	const kind = oneOf(where, "kind", root.kind, PLUGIN_KINDS);
	const entry = entryPoint(where, root.entry);
	const transport = oneOf(where, "transport", root.transport, PLUGIN_TRANSPORTS, "ipc");
	if (kind === "hook" && transport === "udp") fail(where, "transport", "a hook cannot use the udp transport; udp carries events only, never request and response");
	const endpoint = optionalString(where, "endpoint", root.endpoint);
	if (root.remote !== undefined && typeof root.remote !== "boolean") fail(where, "remote", "remote must be true or false");
	const remote = root.remote === true;
	if ("builtin" in entry) {
		if (endpoint !== undefined) fail(where, "endpoint", "a built-in plugin runs in process and takes no endpoint");
		if (remote) fail(where, "remote", "a built-in plugin cannot be remote");
	} else checkEndpoint(where, name, transport, remote, endpoint);
	const source = optionalString(where, "source", root.source);
	const pin = pinOf(where, root, kind, source);
	const capabilities = table(where, "capabilities", root.capabilities);
	onlyKeys(where, "capabilities", capabilities, ["network", "fs_read", "fs_write", "exec"]);
	if (capabilities.network !== undefined && typeof capabilities.network !== "boolean") fail(where, "capabilities.network", "capabilities.network must be true or false");
	const permissions = table(where, "permissions", root.permissions);
	onlyKeys(where, "permissions", permissions, ["credentials", "env"]);
	const credentials = stringList(where, "permissions.credentials", permissions.credentials);
	for (const credential of credentials)
		if (!CREDENTIAL_NAME_PATTERN.test(credential)) fail(where, "permissions.credentials", `${credential} is not a valid credential name`);
	if (transport === "tcp" && credentials.includes(pluginTokenCredential(name)))
		fail(where, "permissions.credentials", TCP_TOKEN_PROBLEM);
	return {
		name,
		version,
		kind,
		transport,
		...(endpoint === undefined ? {} : { endpoint }),
		remote,
		...(source === undefined ? {} : { source }),
		...(pin === undefined ? {} : { pin }),
		entry,
		capabilities: {
			network: capabilities.network === true,
			fs_read: stringList(where, "capabilities.fs_read", capabilities.fs_read),
			fs_write: stringList(where, "capabilities.fs_write", capabilities.fs_write),
			exec: stringList(where, "capabilities.exec", capabilities.exec),
		},
		permissions: { credentials, env: stringList(where, "permissions.env", permissions.env) },
	};
}

function listed(values: string[]): string {
	return values.length === 0 ? "none" : values.join(", ");
}

/** What dg enforces for a plugin and what it can only report, for `dg plugin verify`. */
export function permissionReport(manifest: PluginManifest): { enforced: string[]; unenforced: string[] } {
	if ("builtin" in manifest.entry) return { enforced: [], unenforced: [] };
	const { capabilities, permissions } = manifest;
	return {
		enforced: [
			`exec allowlist: ${listed(capabilities.exec)}`,
			`credentials: ${listed(permissions.credentials)}`,
			`environment: ${listed(permissions.env)}`,
			"working directory: the plugin folder",
			"timeouts: per route",
		],
		unenforced: [
			`network access: ${capabilities.network ? "declared" : "not declared"}`,
			`file read: ${listed(capabilities.fs_read)}`,
			`file write: ${listed(capabilities.fs_write)}`,
		],
	};
}
