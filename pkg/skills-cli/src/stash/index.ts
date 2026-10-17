import { mkdirSync } from "node:fs";
import path from "node:path";
import { agentsPath, agentsRoot, scratchDir, scratchRoot, stateDir, stateRoot, uniqueName } from "@dg/common/node";

/** Choose ephemeral scratch, durable project state, or current/main worktree artifacts. */
export type StashKind = "scratch" | "state" | "agents" | "main";

/** Parsed scope and naming options; resolution validates combinations and path safety. */
export interface StashArgs {
	kind: StashKind;
	global: boolean;
	unique: boolean;
	root: boolean;
	help: boolean;
	dir?: string;
	tool?: string;
	name?: string;
}

/** Resolved absolute destination plus an optional warning when a repository artifact is not ignored. */
export interface StashResult {
	path: string;
	warning?: string;
}

/** Compatibility help for stash scopes and flags; parsing preserves usage-error exit 1. */
export const USAGE = `Usage: stash [flags] <tool> [name]

Prints one absolute path and creates its parent (the dir itself without a name).

  --scratch         $AI_SCRATCH_DIR/<tool>/<cwd-hash> (default)
  -s, --state       $AI_STATE_DIR/<tool>/<project-hash>
  -a, --agents      <worktree>/.agents/<tool>
  -m, --main        <main worktree>/.agents/<tool>
  -G, --global      no bucket (scratch or state only)
  -u, --unique      unique name; a given name becomes the suffix
  -r, --root        print only the root; tool not required
  -C, --dir <dir>   compute bucket or toplevel as if run from <dir>
  -h, --help        show this help
`;

const KIND_FLAGS: Record<string, StashKind> = {
	"--scratch": "scratch",
	"-s": "state",
	"--state": "state",
	"-a": "agents",
	"--agents": "agents",
	"-m": "main",
	"--main": "main",
};

const SHORT_BOOLEAN = new Set(["s", "a", "m", "G", "u", "r", "h"]);

function expandShort(argv: string[]): string[] {
	return argv.flatMap((arg) => {
		if (!/^-[A-Za-z]{2,}$/.test(arg)) return [arg];
		const letters = [...arg.slice(1)];
		const valueFlag = letters.indexOf("C");
		const booleans = valueFlag === -1 ? letters : letters.slice(0, valueFlag);
		if (!booleans.every((l) => SHORT_BOOLEAN.has(l))) return [arg];
		return [...booleans.map((l) => `-${l}`), ...(valueFlag === -1 ? [] : ["-C"])];
	});
}

/** Parse raw stash flags, including grouped short flags; reject conflicting scopes and excess arguments. */
export function parseArgs(argv: string[]): StashArgs {
	const parsed: StashArgs = { kind: "scratch", global: false, unique: false, root: false, help: false };
	const chosen = new Set<StashKind>();
	const positional: string[] = [];
	const args = expandShort(argv);
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		const kind = KIND_FLAGS[arg];
		if (kind) {
			chosen.add(kind);
			parsed.kind = kind;
		} else if (arg === "-G" || arg === "--global") parsed.global = true;
		else if (arg === "-u" || arg === "--unique") parsed.unique = true;
		else if (arg === "-r" || arg === "--root") parsed.root = true;
		else if (arg === "-h" || arg === "--help") parsed.help = true;
		else if (arg === "-C" || arg === "--dir") {
			const value = args[++i];
			if (!value) throw new Error(`${arg} requires a directory`);
			parsed.dir = value;
		} else if (arg.startsWith("--dir=")) parsed.dir = arg.slice("--dir=".length);
		else if (arg.startsWith("-") && arg !== "-") throw new Error(`unknown flag ${arg}`);
		else positional.push(arg);
	}
	if (chosen.size > 1) throw new Error("choose one of --scratch, --state, --agents, --main");
	if (positional.length > 2) throw new Error("too many arguments");
	[parsed.tool, parsed.name] = positional;
	return parsed;
}

function assertSafe(label: string, value: string): void {
	const segments = value.split("/");
	if (path.isAbsolute(value) || segments.some((s) => s === "" || s === "..")) {
		throw new Error(`${label} must be a relative path without '..' or empty segments, got: ${value}`);
	}
}

function nameWithSuffix(tool: string, name: string | undefined): string {
	if (!name) return uniqueName(tool);
	return uniqueName(tool, name.startsWith(".") ? name : `-${name}`);
}

function isIgnored(top: string, target: string): boolean {
	return Bun.spawnSync(["git", "check-ignore", "-q", target], { cwd: top, stderr: "ignore" }).exitCode !== 1;
}

/** Create the destination parent without creating the file; reject incompatible scopes or unsafe relative paths. */
export function resolveStash(args: StashArgs): StashResult {
	const cwd = args.dir ? path.resolve(args.dir) : undefined;
	const repoLocal = args.kind === "agents" || args.kind === "main";
	if (repoLocal && args.global) throw new Error("--global cannot be used with --agents or --main");

	if (args.root) {
		const root = repoLocal
			? agentsRoot({ cwd, main: args.kind === "main" })
			: args.kind === "state"
				? stateRoot()
				: scratchRoot();
		return { path: root };
	}

	if (!args.tool) throw new Error("missing <tool>");
	assertSafe("tool", args.tool);
	if (args.name) assertSafe("name", args.name);
	const name = args.unique ? nameWithSuffix(args.tool, args.name) : args.name;

	if (repoLocal) {
		const main = args.kind === "main";
		const target = agentsPath(args.tool, name, { cwd, main });
		const root = agentsRoot({ cwd, main });
		const warning = isIgnored(path.dirname(root), path.join(root, args.tool))
			? undefined
			: `.agents/${args.tool} is not git-ignored`;
		return { path: target, warning };
	}

	const opts = { cwd, cwdScope: !args.global };
	const dir = args.kind === "state" ? stateDir(args.tool, opts) : scratchDir(args.tool, opts);
	if (!name) return { path: dir };
	const target = path.join(dir, name);
	mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
	return { path: target };
}

/** Print the resolved path, send warnings to stderr, and return 1 for parsing or resolution errors. */
export function main(argv: string[]): number {
	try {
		const args = parseArgs(argv);
		if (args.help) {
			process.stdout.write(USAGE);
			return 0;
		}
		const result = resolveStash(args);
		if (result.warning) process.stderr.write(`stash: ${result.warning}\n`);
		process.stdout.write(`${result.path}\n`);
		return 0;
	} catch (error) {
		process.stderr.write(`stash: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}
