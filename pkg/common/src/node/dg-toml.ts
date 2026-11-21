import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseStrict, stringify } from "smol-toml";
import { CREDENTIAL_NAME_PATTERN } from "../credentials-format";
import { DgCliError } from "../errors";
import { type DgPaths, resolveDgPaths } from "./dg-paths";
import { withinRoot, writeFilePreserving } from "./fs";

type Env = Record<string, string | undefined>;
type Table = Record<string, unknown>;

export type SecretRef = { credential: string };

export type PluginEntry = { enabled: boolean; source?: string; settings: Table };

export type DgToml = {
	hooks: Record<string, Record<string, string>>;
	install: { cli_only: boolean };
	refs: { default_repo?: string; aliases: Record<string, string> };
	inbox: Table;
	ssms: Table;
	plugins: Record<string, PluginEntry>;
	meta: { migrated: Record<string, string> };
};

export const DG_TOML_SECTIONS = ["hooks", "install", "refs", "inbox", "ssms", "plugins", "meta"] as const;

export const DG_TOML_DEFAULTS: Readonly<Record<string, unknown>> = {
	"install.cli_only": false,
	"ssms.allow_send": false,
	"ssms.google.send_enabled": false,
};

const SECRET_FIELDS: ReadonlySet<string> = new Set(["inbox.gmail.clientSecret", "inbox.outlook.clientSecret"]);

const SECRET_KEY_NAME = /(?:secret|token|password|passwd|api[_-]?key|private[_-]?key)$/i;

const TOKEN_LIKE =
	/^(?:gh[pousr]_|github_pat_|sk-|xox[abpr]-|glpat-|AKIA|ASIA|AIza|ya29\.)|^(?=.*[0-9])(?=.*[a-z])(?=.*[A-Z])[A-Za-z0-9_-]{32,}={0,2}$/;

const UNSAFE_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

const NEXT_EDIT = "Next: run dg config edit, or dg config set";

export function isRecord(value: unknown): value is Table {
	return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

export function isSecretRef(value: unknown): value is SecretRef {
	return (
		isRecord(value) &&
		Object.keys(value).length === 1 &&
		typeof value.credential === "string" &&
		CREDENTIAL_NAME_PATTERN.test(value.credential)
	);
}

/** True for a key whose value must be a credential reference. */
export function isSecretKey(key: string): boolean {
	if (SECRET_FIELDS.has(key)) return true;
	const parts = key.split(".");
	return parts[0] === "plugins" && parts[2] === "settings" && parts.length > 3 && SECRET_KEY_NAME.test(parts.at(-1) ?? "");
}

function splitKey(raw: string): string[] {
	const parts: string[] = [];
	let current = "";
	let quote = "";
	for (const char of raw) {
		if (quote) {
			if (char === quote) quote = "";
			else current += char;
		} else if (char === '"' || char === "'") quote = char;
		else if (char === ".") {
			parts.push(current.trim());
			current = "";
		} else current += char;
	}
	parts.push(current.trim());
	return parts;
}

/** The 1-based line that sets `key` in `text`, or 1 when no line names it. */
export function lineOfKey(text: string, key: string): number {
	const lines = text.split(/\r?\n/);
	let table: string[] = [];
	let near = 0;
	for (const [index, line] of lines.entries()) {
		const raw = line.trim();
		const header = /^\[\[?([^\]]+)\]\]?/.exec(raw);
		if (header) {
			table = splitKey(header[1] ?? "");
			const name = table.join(".");
			if (name === key) return index + 1;
			if (!near && key.startsWith(`${name}.`)) near = index + 1;
			continue;
		}
		const assign = /^((?:"[^"]*"|'[^']*'|[A-Za-z0-9_.\s-])+?)\s*=/.exec(raw);
		if (!assign) continue;
		const full = [...table, ...splitKey(assign[1] ?? "")].join(".");
		if (full === key) return index + 1;
		if (key.startsWith(`${full}.`)) near = index + 1;
	}
	return near || 1;
}

function shown(value: unknown): string {
	const text = JSON.stringify(value) ?? String(value);
	return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

type Where = { file: string; text: string };

function fail(where: Where, key: string, message: string): never {
	throw new DgCliError(`dg config: ${where.file}:${lineOfKey(where.text, key)}: ${message}`);
}

function mustBe(where: Where, key: string, type: string, value: unknown): never {
	fail(where, key, `${key} must be ${type}, got ${shown(value)}. ${NEXT_EDIT} ${key} <value>.`);
}

function mustBeSecretRef(where: Where, key: string): never {
	fail(
		where,
		key,
		`${key} must be a credential reference { credential = "<name>" }, got a plain value. Next: store the value with dg credentials set <name>, then run dg config set ${key} --credential <name>.`,
	);
}

function checkStrings(where: Where, key: string, value: unknown): void {
	if (typeof value === "string") {
		if (value.includes("{{resolve:"))
			fail(where, key, `${key} must not hold a {{resolve:...}} placeholder. ${NEXT_EDIT} ${key} <value>.`);
		return;
	}
	if (Array.isArray(value)) {
		value.forEach((item, index) => checkStrings(where, `${key}.${index}`, item));
		return;
	}
	if (!isRecord(value)) return;
	for (const [name, item] of Object.entries(value)) {
		if (UNSAFE_KEYS.has(name)) fail(where, `${key}.${name}`, `${key}.${name} is not an allowed key. ${NEXT_EDIT} ${key} <value>.`);
		checkStrings(where, `${key}.${name}`, item);
	}
}

function checkSecrets(where: Where, key: string, value: unknown): void {
	if (isSecretRef(value)) return;
	const refused = SECRET_FIELDS.has(key) || typeof value === "string" || isRecord(value) || Array.isArray(value);
	if (isSecretKey(key) && refused) mustBeSecretRef(where, key);
	if (isRecord(value)) {
		for (const [name, item] of Object.entries(value)) checkSecrets(where, `${key}.${name}`, item);
		return;
	}
	if (Array.isArray(value)) {
		value.forEach((item, index) => checkSecrets(where, `${key}.${index}`, item));
		return;
	}
	if (key.startsWith("plugins.") && key.split(".")[2] === "settings" && typeof value === "string" && TOKEN_LIKE.test(value))
		mustBeSecretRef(where, key);
}

function table(where: Where, key: string, value: unknown): Table {
	if (value === undefined) return {};
	if (!isRecord(value)) mustBe(where, key, "a table", value);
	return value;
}

function stringTable(where: Where, key: string, value: unknown): Record<string, string> {
	const out = table(where, key, value);
	for (const [name, item] of Object.entries(out))
		if (typeof item !== "string") mustBe(where, `${key}.${name}`, "a string", item);
	return out as Record<string, string>;
}

function optionalBoolean(where: Where, key: string, value: unknown, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	if (typeof value !== "boolean") mustBe(where, key, "a boolean", value);
	return value;
}

function optionalString(where: Where, key: string, value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") mustBe(where, key, "a string", value);
	return value;
}

function onlyKeys(where: Where, key: string, value: Table, allowed: readonly string[]): void {
	for (const name of Object.keys(value))
		if (!allowed.includes(name)) fail(where, `${key}.${name}`, `${key}.${name} is not a dg config key. ${NEXT_EDIT} ${key}.<key> <value>.`);
}

function plugin(where: Where, key: string, value: unknown): PluginEntry {
	if (key.split(".").length !== 2)
		fail(where, key, `${key} is not a valid plugin name; a plugin name has no dot. ${NEXT_EDIT} plugins.<name>.enabled <value>.`);
	const entry = table(where, key, value);
	onlyKeys(where, key, entry, ["enabled", "source", "settings"]);
	const source = optionalString(where, `${key}.source`, entry.source);
	return {
		enabled: optionalBoolean(where, `${key}.enabled`, entry.enabled, true),
		...(source === undefined ? {} : { source }),
		settings: table(where, `${key}.settings`, entry.settings),
	};
}

/** Checks a parsed config.toml and fills every section with its default. */
export function validateDgToml(raw: unknown, where: Where): DgToml {
	const root = isRecord(raw) ? raw : {};
	for (const name of Object.keys(root))
		if (!(DG_TOML_SECTIONS as readonly string[]).includes(name))
			fail(where, name, `${name} is not a dg config section. ${NEXT_EDIT} <section>.<key> <value>.`);
	for (const [name, value] of Object.entries(root)) {
		checkStrings(where, name, value);
		checkSecrets(where, name, value);
	}
	const hooksTable = table(where, "hooks", root.hooks);
	const hooks: DgToml["hooks"] = {};
	for (const [id, value] of Object.entries(hooksTable)) hooks[id] = stringTable(where, `hooks.${id}`, value);
	const install = table(where, "install", root.install);
	onlyKeys(where, "install", install, ["cli_only"]);
	const refs = table(where, "refs", root.refs);
	onlyKeys(where, "refs", refs, ["default_repo", "aliases"]);
	const defaultRepo = optionalString(where, "refs.default_repo", refs.default_repo);
	const ssms = table(where, "ssms", root.ssms);
	optionalBoolean(where, "ssms.allow_send", ssms.allow_send, false);
	optionalBoolean(where, "ssms.google.send_enabled", table(where, "ssms.google", ssms.google).send_enabled, false);
	const plugins: DgToml["plugins"] = {};
	for (const [name, value] of Object.entries(table(where, "plugins", root.plugins)))
		plugins[name] = plugin(where, `plugins.${name}`, value);
	const meta = table(where, "meta", root.meta);
	onlyKeys(where, "meta", meta, ["migrated"]);
	return {
		hooks,
		install: { cli_only: optionalBoolean(where, "install.cli_only", install.cli_only, false) },
		refs: { ...(defaultRepo === undefined ? {} : { default_repo: defaultRepo }), aliases: stringTable(where, "refs.aliases", refs.aliases) },
		inbox: table(where, "inbox", root.inbox),
		ssms,
		plugins,
		meta: { migrated: stringTable(where, "meta.migrated", meta.migrated) },
	};
}

function syntaxLine(text: string): number {
	try {
		parseStrict(text);
	} catch (error) {
		const line = (error as { line?: unknown }).line;
		if (typeof line === "number" && line > 0) return line;
	}
	return 1;
}

function parseToml(where: Where): Table {
	try {
		return Bun.TOML.parse(where.text) as Table;
	} catch (error) {
		const reason = (error instanceof Error ? error.message : String(error)).replace(/^TOML Parse error:\s*/, "");
		throw new DgCliError(`dg config: ${where.file}:${syntaxLine(where.text)}: ${reason}. ${NEXT_EDIT} <key> <value>.`);
	}
}

function tomlFile(env: Env): string {
	return resolveDgPaths({ env }).configTomlPath;
}

/** Parses and checks a config.toml text, naming `file` in each error. */
export function parseDgToml(text: string, file: string): DgToml {
	const where = { file, text };
	return validateDgToml(parseToml(where), where);
}

export type LegacySource = { id: "hooks" | "cli-only" | "browser-batch" | "inbox" | "ssms"; path: string };

export type LegacySecret = { key: string; name: string; value: string };

export type LegacyConfig = { raw: Table; secrets: LegacySecret[]; sources: string[] };

export type LegacySeams = { env?: Env; homeDir?: string; platform?: NodeJS.Platform };

function insideFence(path: string, env: Env, platform: NodeJS.Platform): boolean {
	const fence = env.DG_PATH_FENCE;
	return !fence || withinRoot(fence, path, platform);
}

/** The pre-TOML config files, in fold order; a file outside DG_PATH_FENCE is left out. */
export function legacySources(paths: DgPaths, { env = process.env, homeDir, platform = process.platform }: LegacySeams = {}): LegacySource[] {
	const inboxHome = env.EMAIL_ORGANIZER_HOME ?? env.EMAIL_ORGANIZER_CONFIG_HOME ?? join(paths.stateDir, "inbox", "config");
	const all: LegacySource[] = [
		{ id: "hooks", path: paths.configPath },
		{ id: "cli-only", path: paths.cliOnlyMarker },
		{ id: "browser-batch", path: join(homeDir ?? homedir(), ".config", "browser-batch", "config.json") },
		{ id: "inbox", path: join(inboxHome, "organizer.config.json") },
		{ id: "ssms", path: join(paths.configDir, "ssms", "config.yaml") },
	];
	return all.filter((source) => insideFence(source.path, env, platform));
}

function unreadable(path: string, kind: string, error: unknown): never {
	const reason = error instanceof Error ? error.message : String(error);
	throw new DgCliError(
		`dg config: ${path} is not valid ${kind} (${reason}). Next: fix or move ${path}, then run the command again. Nothing was changed.`,
	);
}

function readObject(path: string, kind: "JSON" | "YAML"): Table {
	let parsed: unknown;
	try {
		const text = readFileSync(path, "utf8");
		parsed = kind === "JSON" ? JSON.parse(text) : Bun.YAML.parse(text);
	} catch (error) {
		unreadable(path, kind, error);
	}
	if (parsed === null || parsed === undefined) return {};
	if (!isRecord(parsed)) unreadable(path, kind, new Error("the top level is not an object"));
	return parsed;
}

const INBOX_SECRETS = [
	["gmail", "clientSecret", "dg-config/inbox-gmail-client-secret"],
	["outlook", "clientSecret", "dg-config/inbox-outlook-client-secret"],
] as const;

function foldInbox(source: Table, secrets: LegacySecret[]): Table {
	const inbox = structuredClone(source);
	for (const [provider, field, name] of INBOX_SECRETS) {
		const section = inbox[provider];
		if (!isRecord(section) || typeof section[field] !== "string") continue;
		if (section[field] === "") {
			delete section[field];
			continue;
		}
		secrets.push({ key: `inbox.${provider}.${field}`, name, value: section[field] });
		section[field] = { credential: name };
	}
	return inbox;
}

function foldRefs(source: Table): Table {
	const refs: Table = {};
	if (source.defaultRepo !== undefined) refs.default_repo = source.defaultRepo;
	if (source.aliases !== undefined) refs.aliases = source.aliases;
	return refs;
}

/** Reads every pre-TOML source into one raw TOML table; secret values come back apart, with references in their place. */
export function readLegacyConfig(paths: DgPaths, seams: LegacySeams = {}): LegacyConfig {
	const raw: Table = {};
	const secrets: LegacySecret[] = [];
	const sources: string[] = [];
	for (const { id, path } of legacySources(paths, seams)) {
		if (!existsSync(path)) continue;
		sources.push(path);
		if (id === "hooks") {
			const hooks = readObject(path, "JSON").hooks;
			if (hooks !== undefined) raw.hooks = hooks;
		} else if (id === "cli-only") raw.install = { cli_only: true };
		else if (id === "browser-batch") {
			const refs = foldRefs(readObject(path, "JSON"));
			if (Object.keys(refs).length) raw.refs = refs;
		} else if (id === "inbox") raw.inbox = foldInbox(readObject(path, "JSON"), secrets);
		else raw.ssms = readObject(path, "YAML");
	}
	return { raw, secrets, sources };
}

function withoutSecrets(legacy: LegacyConfig): Table {
	const raw = structuredClone(legacy.raw);
	for (const { key } of legacy.secrets) {
		const parts = key.split(".");
		const parent = dgTomlValue(raw, parts.slice(0, -1).join("."));
		if (isRecord(parent)) delete parent[parts.at(-1) as string];
	}
	return raw;
}

/** The config.toml values; before migration it reads the old sources with secret values left out, and with none it gives defaults. */
export function readDgToml(env: Env = process.env): DgToml {
	return readDgTomlFor(resolveDgPaths({ env }), { env });
}

/** readDgToml for paths that a caller already resolved, such as a doctor context. */
export function readDgTomlFor(paths: DgPaths, seams: LegacySeams = {}): DgToml {
	const file = paths.configTomlPath;
	if (existsSync(file)) return parseDgToml(readFileSync(file, "utf8"), file);
	const raw = withoutSecrets(readLegacyConfig(paths, seams));
	return validateDgToml(raw, { file, text: "" });
}

function keyParts(key: string): string[] {
	const parts = key.split(".");
	if (parts.some((part) => part === "" || UNSAFE_KEYS.has(part)))
		throw new DgCliError(`dg config: ${key} is not a valid key. Next: use dotted names such as install.cli_only.`);
	return parts;
}

/** The value at a dotted key, or undefined. */
export function dgTomlValue(doc: unknown, key: string): unknown {
	let node: unknown = doc;
	for (const part of keyParts(key)) {
		if (!isRecord(node)) return undefined;
		node = node[part];
	}
	return node;
}

function envValue(name: string, raw: string, like: unknown): unknown {
	if (typeof like === "boolean") {
		if (/^(?:1|true|yes|on)$/i.test(raw)) return true;
		if (/^(?:0|false|no|off)$/i.test(raw)) return false;
		throw new DgCliError(`dg config: ${name} must be true or false (or 1, 0, yes, no, on, off). Next: fix or unset ${name}.`);
	}
	if (typeof like === "number") {
		if (raw.trim() !== "" && Number.isFinite(Number(raw))) return Number(raw);
		throw new DgCliError(`dg config: ${name} must be a number. Next: fix or unset ${name}.`);
	}
	return raw;
}

export type SettingOptions<T> = { flag?: T; envVar?: string; env?: Env };

/** A setting from the CLI flag, then the env var, then config.toml, then the schema default. */
export function setting<T>(key: string, { flag, envVar, env = process.env }: SettingOptions<T> = {}): T {
	if (flag !== undefined) return flag;
	const fromToml = dgTomlValue(readDgToml(env), key);
	const fallback = DG_TOML_DEFAULTS[key];
	const raw = envVar ? env[envVar] : undefined;
	if (envVar && raw !== undefined) return envValue(envVar, raw, fallback ?? fromToml) as T;
	return (fromToml ?? fallback) as T;
}

/** The TOML text of `doc`. */
export function stringifyDgToml(doc: Table): string {
	return `${stringify(doc).trim()}\n`;
}

function readText(file: string): string {
	return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function rawDoc(file: string): { raw: Table; text: string } {
	const text = readText(file);
	const where = { file, text };
	const raw = parseToml(where);
	validateDgToml(raw, where);
	return { raw, text };
}

/** Writes `value` at `key` in `raw`, making tables on the way. */
export function setDgTomlValue(raw: Table, key: string, value: unknown): void {
	const parts = keyParts(key);
	let node = raw;
	for (const part of parts.slice(0, -1)) {
		const next = node[part];
		if (next === undefined) node[part] = {};
		else if (!isRecord(next) || isSecretRef(next))
			throw new DgCliError(`dg config: ${key} is inside ${part}, which is not a table. Next: run dg config edit.`);
		node = node[part] as Table;
	}
	node[parts.at(-1) as string] = value;
}

/** Writes a validated config.toml for `raw` to `file` atomically with mode 0600. */
export function writeDgTomlDoc(raw: Table, file: string): DgToml {
	const text = stringifyDgToml(raw);
	const doc = parseDgToml(text, file);
	mkdirSync(dirname(file), { recursive: true });
	writeFilePreserving(file, text, 0o600);
	return doc;
}

function assertMigrated(file: string, env: Env): void {
	if (!existsSync(file) && readLegacyConfig(resolveDgPaths({ env }), { env }).sources.length)
		throw new DgCliError(
			`dg config: ${file} does not exist yet, and older config files still wait to move into it. Next: start the daemon with dg daemon start if it is stopped, run dg doctor so the move runs, then run this again.`,
		);
}

/** Sets one key in config.toml; it validates first and never writes a secret value. */
export function writeDgToml(key: string, value: unknown, env: Env = process.env): DgToml {
	const file = tomlFile(env);
	if (isSecretKey(key) && typeof value === "string") mustBeSecretRef({ file, text: "" }, key);
	assertMigrated(file, env);
	return updateDoc(file, (raw) => {
		setDgTomlValue(raw, key, value);
		return raw;
	});
}

const UPDATE_TRIES = 3;

function updateDoc(file: string, change: (raw: Table) => Table): DgToml {
	for (let attempt = 1; ; attempt++) {
		const { raw, text } = rawDoc(file);
		const next = change(raw);
		if (readText(file) === text) return writeDgTomlDoc(next, file);
		if (attempt >= UPDATE_TRIES)
			throw new DgCliError(`dg config: ${file} kept changing while dg wrote it. Next: run the command again.`);
	}
}

function deepMerge(base: Table, patch: Table): Table {
	const out: Table = { ...base };
	for (const [key, value] of Object.entries(patch)) {
		if (UNSAFE_KEYS.has(key)) continue;
		const current = out[key];
		out[key] = isRecord(value) && !isSecretRef(value) ? deepMerge(isRecord(current) ? current : {}, value) : value;
	}
	return out;
}

/** Deep-merges `patch` into config.toml after the same checks as writeDgToml. */
export function mergeDgToml(patch: Table, env: Env = process.env): DgToml {
	const file = tomlFile(env);
	assertMigrated(file, env);
	return updateDoc(file, (raw) => deepMerge(raw, patch));
}
