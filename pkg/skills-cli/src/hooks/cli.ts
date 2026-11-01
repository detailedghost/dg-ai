import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { readDgConfig, resolveDgPaths, writeDgConfig } from "@dg/common/node";
import { HOOKS } from "./manifest";
import { defaultSeams, runHook } from "./run";
import { claudeWriter } from "./settings/claude";
import { codexWriter } from "./settings/codex";
import { opencodeWriter } from "./settings/opencode";
import type {
	HookDefinition,
	HookEnv,
	HookRuntime,
	HookSeams,
	SettingsWriter,
} from "./types";

export interface HooksIo {
	stdin: AsyncIterable<string | Uint8Array>;
	env: HookEnv;
	seams: HookSeams;
	home?: string;
	launcher?: string;
}

const USAGE = `usage: hooks <command>
  run <id>
  list
  status [--json]
  enable <id>... [--runtime <runtime>]... [--set key=value]...
  disable <id>|--all [--runtime <runtime>]...
  set <id> <key> <value>
`;

const RUNTIMES: readonly HookRuntime[] = ["claude", "codex", "opencode"];
const COMMANDS = ["list", "status", "enable", "disable", "set"];
const NOTICE = "(takes effect in new sessions)";

class UsageError extends Error {}

function writers(
	home: string,
	launcher: string,
	configHome?: string,
	codexHome?: string,
): Record<HookRuntime, SettingsWriter> {
	return {
		claude: claudeWriter(home),
		codex: codexWriter(home, codexHome),
		opencode: opencodeWriter(home, launcher, configHome),
	};
}

function defaultLauncher(env: HookEnv): string {
	const bin = process.platform === "win32" ? "dg-skills.exe" : "dg-skills";
	const stateDir = resolveDgPaths({ env }).stateDir;
	if (!isAbsolute(stateDir))
		throw new UsageError(`DG_HOME ${stateDir} must be an absolute path`);
	return join(stateDir, "bin", bin);
}

interface Parsed {
	positional: string[];
	runtimes: HookRuntime[];
	sets: string[];
	all: boolean;
	json: boolean;
}

function parseArgs(args: string[]): Parsed {
	const parsed: Parsed = {
		positional: [],
		runtimes: [],
		sets: [],
		all: false,
		json: false,
	};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (arg === "--all") parsed.all = true;
		else if (arg === "--json") parsed.json = true;
		else if (arg === "--runtime" || arg === "--set") {
			const value = args[++i];
			if (value === undefined) throw new UsageError(`${arg} needs a value`);
			if (arg === "--set") parsed.sets.push(value);
			else if ((RUNTIMES as readonly string[]).includes(value))
				parsed.runtimes.push(value as HookRuntime);
			else
				throw new UsageError(
					`unknown runtime ${value}; use ${RUNTIMES.join(", ")}`,
				);
		} else if (arg.startsWith("--"))
			throw new UsageError(`unknown flag ${arg}`);
		else parsed.positional.push(arg);
	}
	return parsed;
}

function definition(id: string | undefined): HookDefinition {
	const def = HOOKS.find((h) => h.id === id);
	if (!def)
		throw new UsageError(
			`unknown hook ${id ?? ""}; use ${HOOKS.map((h) => h.id).join(", ")}`,
		);
	return def;
}

function checkedSetting(
	def: HookDefinition,
	key: string,
	value: string,
): string {
	const spec = Object.hasOwn(def.settings ?? {}, key)
		? def.settings?.[key]
		: undefined;
	if (!spec) throw new UsageError(`hook ${def.id} has no setting ${key}`);
	const match = spec.values.find(
		(v) => v.toLowerCase() === value.toLowerCase(),
	);
	if (!match)
		throw new UsageError(
			`${def.id}.${key} must be one of ${spec.values.join(", ")}`,
		);
	return match;
}

function selectRuntimes(
	requested: HookRuntime[],
	all: Record<HookRuntime, SettingsWriter>,
): HookRuntime[] {
	if (requested.length > 0) return [...new Set(requested)];
	return RUNTIMES.filter((r) => existsSync(all[r].dir));
}

function list(io: HooksIo): number {
	for (const hook of HOOKS)
		io.seams.stdout(
			`${hook.id}\t${hook.summary}\t${hook.runtimes.join(",")}\n`,
		);
	return 0;
}

function configValues(io: HooksIo): string[] {
	const stored = readDgConfig(io.env).hooks as
		| Record<string, Record<string, unknown> | undefined>
		| undefined;
	return HOOKS.flatMap((hook) =>
		Object.entries(hook.settings ?? {}).map(([key, spec]) => {
			const value = stored?.[hook.id]?.[key];
			return `${hook.id}.${key} = ${typeof value === "string" ? value : spec.default}`;
		}),
	);
}

async function status(
	parsed: Parsed,
	io: HooksIo,
	all: Record<HookRuntime, SettingsWriter>,
): Promise<number> {
	const runtimes = Object.fromEntries(
		RUNTIMES.map((r) => {
			const info = { enabled: [] as string[], settingsFile: all[r].file };
			try {
				return [r, { ...info, enabled: all[r].enabled() }];
			} catch (error) {
				return [
					r,
					{
						...info,
						error: error instanceof Error ? error.message : String(error),
					},
				];
			}
		}),
	);
	const failed = Object.values(runtimes).some((info) => "error" in info);
	if (parsed.json) {
		io.seams.stdout(`${JSON.stringify({ runtimes }, null, 2)}\n`);
		return failed ? 1 : 0;
	}
	for (const [runtime, info] of Object.entries(runtimes))
		io.seams.stdout(
			"error" in info
				? `${runtime}: error: ${info.error}\n`
				: `${runtime}: ${info.enabled.length > 0 ? info.enabled.join(", ") : "none"} (${info.settingsFile})\n`,
		);
	for (const line of configValues(io)) io.seams.stdout(`${line}\n`);
	return failed ? 1 : 0;
}

async function enable(
	parsed: Parsed,
	io: HooksIo,
	all: Record<HookRuntime, SettingsWriter>,
	launcher: string,
): Promise<number> {
	if (parsed.positional.length === 0)
		throw new UsageError("enable needs a hook id");
	const defs = parsed.positional.map(definition);
	const patch: Record<string, Record<string, string>> = {};
	for (const pair of parsed.sets) {
		const at = pair.indexOf("=");
		const key = at < 0 ? "" : pair.slice(0, at);
		const targets = defs.filter((d) => Object.hasOwn(d.settings ?? {}, key));
		if (targets.length === 0)
			throw new UsageError(`--set ${pair}: no enabled hook has that setting`);
		for (const def of targets)
			patch[def.id] = {
				...patch[def.id],
				[key]: checkedSetting(def, key, pair.slice(at + 1)),
			};
	}
	const runtimes = selectRuntimes(parsed.runtimes, all);
	if (runtimes.length === 0) {
		io.seams.stderr("no supported runtime found; pass --runtime\n");
		return 1;
	}
	for (const runtime of runtimes) all[runtime].check();
	const hasPatch = Object.keys(patch).length > 0;
	if (hasPatch) readDgConfig(io.env);
	const changed: HookRuntime[] = [];
	const summary = () =>
		`changed before the failure: ${changed.length > 0 ? changed.join(", ") : "none"}; config values not written\n`;
	for (const runtime of runtimes) {
		try {
			const supported = defs.filter((d) => d.runtimes.includes(runtime));
			const written = await all[runtime].enable(supported, launcher);
			if (written.length > 0) changed.push(runtime);
			for (const id of written)
				io.seams.stdout(`${runtime}: enabled ${id} ${NOTICE}\n`);
			for (const def of defs)
				if (!written.includes(def.id))
					io.seams.stdout(`${runtime}: skipped ${def.id} (not supported)\n`);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			io.seams.stderr(`${runtime}: ${reason}\n`);
			io.seams.stderr(summary());
			return 1;
		}
	}
	if (!hasPatch) return 0;
	try {
		writeDgConfig({ hooks: patch }, io.env);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		io.seams.stderr(`config: ${reason}\n`);
		io.seams.stderr(summary());
		return 1;
	}
	return 0;
}

async function disable(
	parsed: Parsed,
	io: HooksIo,
	all: Record<HookRuntime, SettingsWriter>,
): Promise<number> {
	if (parsed.all === parsed.positional.length > 0)
		throw new UsageError("disable needs a hook id or --all");
	const ids = parsed.all
		? undefined
		: parsed.positional.map((id) => definition(id).id);
	const runtimes = selectRuntimes(parsed.runtimes, all);
	for (const runtime of runtimes) all[runtime].check();
	for (const runtime of runtimes)
		for (const id of await all[runtime].disable(ids))
			io.seams.stdout(`${runtime}: disabled ${id} ${NOTICE}\n`);
	return 0;
}

function set(parsed: Parsed, io: HooksIo): number {
	const [id, key, value] = parsed.positional;
	if (!id || !key || value === undefined)
		throw new UsageError("set needs <id> <key> <value>");
	const def = definition(id);
	writeDgConfig(
		{ hooks: { [def.id]: { [key]: checkedSetting(def, key, value) } } },
		io.env,
	);
	return 0;
}

export async function main(
	argv: string[],
	io: HooksIo = {
		stdin: process.stdin,
		env: process.env,
		seams: defaultSeams(),
	},
): Promise<number> {
	const [command, ...rest] = argv;
	if (command === "run") return runCommand(rest, io);
	if (!command || !COMMANDS.includes(command)) {
		io.seams.stderr(USAGE);
		return 2;
	}
	try {
		const parsed = parseArgs(rest);
		const launcher = io.launcher ?? defaultLauncher(io.env);
		if (!isAbsolute(launcher))
			throw new UsageError(`launcher ${launcher} must be an absolute path`);
		const all = writers(
			io.home ?? homedir(),
			launcher,
			io.env.XDG_CONFIG_HOME,
			io.env.CODEX_HOME,
		);
		switch (command) {
			case "list":
				return list(io);
			case "status":
				return await status(parsed, io, all);
			case "enable":
				return await enable(parsed, io, all, launcher);
			case "disable":
				return await disable(parsed, io, all);
			case "set":
				return set(parsed, io);
			default:
				io.seams.stderr(USAGE);
				return 2;
		}
	} catch (error) {
		io.seams.stderr(
			`${error instanceof Error ? error.message : String(error)}\n`,
		);
		return error instanceof UsageError ? 2 : 1;
	}
}

async function runCommand(
	[id, ...flags]: string[],
	io: HooksIo,
): Promise<number> {
	if (!id) {
		io.seams.stderr(USAGE);
		return 2;
	}
	if (
		id === "daily-prune" &&
		flags.includes("--dry-run") &&
		!flags.includes("--now")
	) {
		io.seams.stderr("hooks run daily-prune: --dry-run requires --now\n");
		return 2;
	}
	if (id === "daily-prune" && flags.includes("--now")) {
		const { runNow } = await import("./defs/daily-prune");
		await runNow(io.env, io.seams.run, flags.includes("--dry-run"));
		return 0;
	}
	return runHook(id, io.stdin, io.env, io.seams);
}
