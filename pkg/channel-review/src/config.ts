import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join as joinPath } from "node:path";
import {
	DgCliError,
	describeError,
	fail,
	isRecord,
	requireFiniteNumber,
	requireOneOf,
	requireRecord,
	requireString,
	requireStringArray,
} from "@dg/common";
import { ensurePrivateDir, writeFileAtomic } from "@dg/common/node";
import { type FunEntry, loadFunPool } from "./fun";
import { isCustomReactionId } from "./providers/teams-relay";
import { REACTION_STATES, type ReactionState } from "./reactions";
import { RUNNER_NAMES, type RunnerName } from "./runners/types";

export const ENV_NAMES = ["dev", "prod"] as const;

export type EnvName = (typeof ENV_NAMES)[number];

export type EnvSettings = { baseUrl: string; awsProfile: string; botName: string };

export const REACTION_DEFAULTS = {
	pending: "1f440_eyes",
	inProgress: "23f1_stopwatch",
	changesRequested: "1f6a7_constructionsign",
	approved: "2705_whiteheavycheckmark",
	comment: "speechbubble",
	failure: "26a0_warningsign",
};

export const SLOT_KEYS = {
	progress: "inProgress",
	approved: "approved",
} as const;
export type Slot = keyof typeof SLOT_KEYS;

export function resolveReactionSlot(name: string): ReactionState | undefined {
	const wanted = name.toLowerCase();
	if (Object.hasOwn(SLOT_KEYS, wanted)) return SLOT_KEYS[wanted as Slot];
	return REACTION_STATES.find((state) => state.toLowerCase() === wanted);
}

const REREVIEW_PHRASES = [
	"ready",
	"fixed",
	"addressed",
	"updated",
	"ptal",
	"re-review",
	"good to go",
];

export type ChatTarget = { topic?: string; id?: string };

export type ChannelConfig = {
	provider: "teams-relay";
	env: { default: EnvName };
	envs: Partial<Record<EnvName, Partial<EnvSettings>>>;
	chats: ChatTarget[];
	owner: { token: string; email: string; senderIds: string[] };
	runner: {
		default: RunnerName;
		timeoutMinutes: number;
		addressTimeoutMinutes: number;
		claude: { path?: string; allowedTools: string[]; addressAllowedTools: string[] };
		codex?: { path?: string };
		copilot?: { path?: string };
	};
	reactions: typeof REACTION_DEFAULTS;
	relay: {
		appName: string;
		secret: { id: string; key: string; region: string };
	};
	fun: { pool?: FunEntry[] };
	rereview: { phrases: string[] };
	hosts: { github: string[]; gitlab: string[] };
	address: { cloneRoot: string; allowAnySender: boolean };
};

type Rec = Record<string, unknown>;

const join = (parent: string, key: string): string =>
	parent === "" ? key : `${parent}.${key}`;

function section(
	parent: Rec,
	key: string,
	parentPath: string,
	allowed: readonly string[],
): Rec {
	const path = join(parentPath, key);
	const value = parent[key];
	if (value === undefined) return {};
	requireRecord(value, path);
	rejectUnknown(value, allowed, path);
	return value;
}

function rejectUnknown(value: Rec, allowed: readonly string[], path: string): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) fail(`${join(path, key)} is not a known key`);
	}
}

function required(rec: Rec, key: string, path: string): string {
	const value = rec[key];
	if (value === undefined) fail(`${join(path, key)} is required`);
	requireString(value, join(path, key), { nonEmpty: true });
	return value;
}

function text(rec: Rec, key: string, path: string, fallback: string): string {
	const value = rec[key] ?? fallback;
	requireString(value, join(path, key), { nonEmpty: true });
	return value;
}

function optionalText(rec: Rec, key: string, path: string): string | undefined {
	if (rec[key] === undefined) return undefined;
	return text(rec, key, path, "");
}

function hostList(rec: Rec, key: string): string[] {
	const value = rec[key] ?? [];
	requireStringArray(value, `hosts.${key}`);
	for (const [index, host] of value.entries()) {
		if (host.trim() === "") fail(`hosts.${key}[${index}] must not be empty`);
	}
	return value.map((host) => host.trim().toLowerCase());
}

function parseChats(raw: Rec): ChatTarget[] {
	if (raw.chat !== undefined && raw.chats !== undefined) {
		fail("chat and chats cannot both be set; use chats");
	}
	if (raw.chats === undefined) {
		if (raw.chat === undefined) fail("chats is required");
		const rec = section(raw, "chat", "", ["topic", "id"]);
		const target = { topic: optionalText(rec, "topic", "chat"), id: optionalText(rec, "id", "chat") };
		if (target.topic === undefined && target.id === undefined) fail("chat needs a topic or an id");
		return [target];
	}
	const list = raw.chats;
	if (!Array.isArray(list)) fail("chats must be an array");
	if (list.length === 0) fail("chats must not be empty");
	const chats = list.map((entry, index) => {
		const path = `chats[${index}]`;
		requireRecord(entry, path);
		rejectUnknown(entry, ["topic", "id"], path);
		const target = {
			topic: optionalText(entry, "topic", path),
			id: optionalText(entry, "id", path),
		};
		if (target.topic === undefined && target.id === undefined) {
			fail(`${path} needs a topic or an id`);
		}
		return target;
	});
	const seen = new Set<string>();
	for (const { id } of chats) {
		if (id === undefined) continue;
		if (seen.has(id)) fail(`chats has a duplicate id ${id}`);
		seen.add(id);
	}
	return chats;
}

function minutes(value: unknown, path: string): number {
	requireFiniteNumber(value, path);
	if (value <= 0) fail(`${path} must be greater than 0`);
	return value;
}

function parseRunner(raw: Rec, cloneRoot: string): ChannelConfig["runner"] {
	const rec = section(raw, "runner", "", [
		"default",
		"timeoutMinutes",
		"addressTimeoutMinutes",
		...RUNNER_NAMES,
	]);
	const defaultRunner = rec.default ?? "claude";
	requireOneOf(defaultRunner, "runner.default", RUNNER_NAMES);
	const timeout = minutes(rec.timeoutMinutes ?? 30, "runner.timeoutMinutes");
	const addressTimeout = minutes(rec.addressTimeoutMinutes ?? 60, "runner.addressTimeoutMinutes");

	const claude = section(rec, "claude", "runner", ["path", "allowedTools", "addressAllowedTools"]);
	const scratch = `/${process.env.AI_SCRATCH_DIR ?? "/tmp/ai"}/thrash/**`;
	const allowedTools = claude.allowedTools ?? [
		`Bash(${homedir()}/scripts/bin/thrash-helper:*)`,
		"Agent",
		`Read(${scratch})`,
		"Read(~/.claude/skills/thrash/**)",
		`Grep(${scratch})`,
		`Glob(${scratch})`,
		`Edit(${scratch})`,
	];
	requireStringArray(allowedTools, "runner.claude.allowedTools");
	const clones = `/${cloneRoot}/**`;
	const addressAllowedTools = claude.addressAllowedTools ?? [
		"Agent",
		`Edit(${clones})`,
		`Read(${clones})`,
		`Grep(${clones})`,
		`Glob(${clones})`,
		"Read(~/.claude/skills/address/**)",
		"Bash(git:*)",
		"Bash(gh:*)",
		"Bash(glab:*)",
		`Bash(${homedir()}/scripts/bin/address-helper:*)`,
		"Bash(bun:*)",
		"Bash(npm:*)",
		"Bash(npx:*)",
		"Bash(dotnet:*)",
		"Bash(python:*)",
		"Bash(pytest:*)",
	];
	requireStringArray(addressAllowedTools, "runner.claude.addressAllowedTools");

	const binary = (name: "codex" | "copilot") =>
		rec[name] === undefined
			? undefined
			: { path: optionalText(section(rec, name, "runner", ["path"]), "path", `runner.${name}`) };

	return {
		default: defaultRunner,
		timeoutMinutes: timeout,
		addressTimeoutMinutes: addressTimeout,
		claude: {
			path: optionalText(claude, "path", "runner.claude"),
			allowedTools,
			addressAllowedTools,
		},
		codex: binary("codex"),
		copilot: binary("copilot"),
	};
}

function parseAddress(raw: Rec): ChannelConfig["address"] {
	const rec = section(raw, "address", "", ["cloneRoot", "allowAnySender"]);
	const cloneRoot = text(rec, "cloneRoot", "address", joinPath(homedir(), "code", "bot"));
	if (!isAbsolute(cloneRoot)) fail("address.cloneRoot must be an absolute path");
	const allowAnySender = rec.allowAnySender ?? false;
	if (typeof allowAnySender !== "boolean") fail("address.allowAnySender must be a boolean");
	return { cloneRoot, allowAnySender };
}

function parseConfig(raw: unknown): ChannelConfig {
	requireRecord(raw, "config");
	rejectUnknown(
		raw,
		[
			"provider",
			"env",
			"envs",
			"chat",
			"chats",
			"owner",
			"runner",
			"reactions",
			"relay",
			"fun",
			"rereview",
			"hosts",
			"address",
		],
		"",
	);

	const provider = raw.provider ?? "teams-relay";
	requireOneOf(provider, "provider", ["teams-relay"]);

	const env = section(raw, "env", "", ["default"]);
	const defaultEnv = env.default ?? "dev";
	requireOneOf(defaultEnv, "env.default", ENV_NAMES);

	const envsRaw = section(raw, "envs", "", ENV_NAMES);
	const envs: ChannelConfig["envs"] = {};
	for (const name of ENV_NAMES) {
		if (envsRaw[name] === undefined) continue;
		const settings = section(envsRaw, name, "envs", ["baseUrl", "awsProfile", "botName"]);
		envs[name] = {
			baseUrl: optionalText(settings, "baseUrl", `envs.${name}`),
			awsProfile: optionalText(settings, "awsProfile", `envs.${name}`),
			botName: optionalText(settings, "botName", `envs.${name}`),
		};
	}

	const chats = parseChats(raw);
	const owner = section(raw, "owner", "", ["token", "email", "senderIds"]);
	requireString(owner.email, "owner.email", { nonEmpty: true });
	const senderIds = owner.senderIds ?? [];
	requireStringArray(senderIds, "owner.senderIds");
	for (const [index, id] of senderIds.entries()) {
		if (id.trim() === "") fail(`owner.senderIds[${index}] must not be empty`);
	}

	const reactionsRaw = section(
		raw,
		"reactions",
		"",
		Object.keys(REACTION_DEFAULTS),
	);
	const reactions = { ...REACTION_DEFAULTS };
	for (const key of Object.keys(REACTION_DEFAULTS) as (keyof typeof reactions)[]) {
		reactions[key] = text(reactionsRaw, key, "reactions", REACTION_DEFAULTS[key]);
	}

	const relay = section(raw, "relay", "", ["appName", "secret"]);
	const appName = required(relay, "appName", "relay");
	if (relay.secret === undefined) fail("relay.secret is required");
	const secret = section(relay, "secret", "relay", ["id", "key", "region"]);

	const funRaw = section(raw, "fun", "", ["pool"]);
	let pool: FunEntry[] | undefined;
	if (funRaw.pool !== undefined) {
		try {
			pool = loadFunPool(funRaw.pool);
		} catch (err) {
			fail(`fun.pool is invalid: ${describeError(err)}`);
		}
	}

	const rereview = section(raw, "rereview", "", ["phrases"]);
	const phrases = rereview.phrases ?? REREVIEW_PHRASES;
	requireStringArray(phrases, "rereview.phrases");
	for (const [index, phrase] of phrases.entries()) {
		if (phrase.trim() === "") fail(`rereview.phrases[${index}] must not be empty`);
	}

	const hostsRaw = section(raw, "hosts", "", ["github", "gitlab"]);
	const address = parseAddress(raw);
	const hosts = { github: hostList(hostsRaw, "github"), gitlab: hostList(hostsRaw, "gitlab") };

	return {
		provider,
		env: { default: defaultEnv },
		envs,
		chats,
		owner: {
			token: required(owner, "token", "owner"),
			email: owner.email,
			senderIds: senderIds.map((id) => id.trim()),
		},
		runner: parseRunner(raw, address.cloneRoot),
		reactions,
		relay: {
			appName,
			secret: {
				id: required(secret, "id", "relay.secret"),
				key: required(secret, "key", "relay.secret"),
				region: required(secret, "region", "relay.secret"),
			},
		},
		fun: { pool },
		rereview: { phrases },
		hosts,
		address,
	};
}

function readText(path: string): string {
	if (!existsSync(path)) throw new DgCliError(`config file ${path} does not exist`);
	return readFileSync(path, "utf8");
}

function parseJson(path: string, source: string): unknown {
	try {
		return JSON.parse(source);
	} catch {
		throw new DgCliError(`config file ${path} is not valid JSON`);
	}
}

export function loadConfig(path: string): ChannelConfig {
	const raw = parseJson(path, readText(path));
	try {
		return parseConfig(raw);
	} catch (err) {
		if (err instanceof TypeError) {
			throw new DgCliError(`invalid config ${path}: ${err.message}`);
		}
		throw err;
	}
}

export function resolveEnv(
	config: ChannelConfig,
	override?: string,
): EnvSettings & { name: EnvName } {
	const name = override ?? config.env.default;
	try {
		requireOneOf(name, "env", ENV_NAMES);
	} catch (err) {
		throw new DgCliError(describeError(err));
	}
	const settings = config.envs[name] ?? {};
	const setting = (key: keyof EnvSettings): string => {
		const value = settings[key];
		if (value === undefined) throw new DgCliError(`envs.${name}.${key} is required`);
		return value;
	};
	return {
		name,
		baseUrl: setting("baseUrl"),
		awsProfile: setting("awsProfile"),
		botName: setting("botName"),
	};
}

function detectIndent(source: string): string {
	return source.match(/^([ \t]+)"/m)?.[1] ?? "\t";
}

export function rewriteConfigKey(
	path: string,
	keyPath: string[],
	value: unknown,
): void {
	const source = readText(path);
	const root = parseJson(path, source);
	if (!isRecord(root)) throw new DgCliError(`config file ${path} is not a JSON object`);

	let node: Rec = root;
	for (const key of keyPath.slice(0, -1)) {
		node[key] ??= {};
		const next = node[key];
		if (!isRecord(next)) {
			throw new DgCliError(`config file ${path}: ${keyPath.join(".")} crosses a non-object`);
		}
		node = next;
	}
	node[keyPath[keyPath.length - 1] as string] = value;

	writeFileAtomic(
		path,
		`${JSON.stringify(root, null, detectIndent(source))}\n`,
		statSync(path).mode & 0o777,
	);
}

export function saveDefaultEnv(path: string, name: EnvName): void {
	if (existsSync(path)) {
		rewriteConfigKey(path, ["env", "default"], name);
		return;
	}
	ensurePrivateDir(dirname(path));
	writeFileAtomic(
		path,
		`${JSON.stringify({ env: { default: name } }, null, "\t")}\n`,
		0o600,
	);
}

export function saveReactionSlot(path: string, slot: ReactionState, id: string): void {
	if (!isCustomReactionId(id)) {
		throw new DgCliError(
			"expected custom reaction id format: name;0-<region>-d<digits>-<32hex>",
		);
	}
	rewriteConfigKey(path, ["reactions", slot], id);
}
