import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { scratchDir } from "@dg/common/node";

/** Throws when the same prototype name exists under more than one git worktree. */
export class AmbiguousPrototypeError extends Error {
	constructor(
		readonly name: string,
		readonly candidates: string[],
	) {
		super(
			[
				`ambiguous prototype "${name}" — found under multiple roots:`,
				...candidates.map((candidate) => `  ${candidate}`),
				"run from inside the intended one, or remove the stale copy, to disambiguate",
			].join("\n"),
		);
	}
}

export interface PrototypeDirOptions {
	light?: boolean;
	cwd?: string;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function gitRun(args: string[], cwd: string): string | undefined {
	const result = Bun.spawnSync(["git", ...args], { cwd, stderr: "ignore" });
	if (result.exitCode !== 0) return undefined;
	return result.stdout.toString();
}

function repoToplevel(cwd: string): string | undefined {
	return gitRun(["rev-parse", "--show-toplevel"], cwd)?.trim() || undefined;
}

function worktreePaths(cwd: string): string[] {
	const output = gitRun(["worktree", "list", "--porcelain"], cwd);
	if (!output) return [];
	return output
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length).trim());
}

/**
 * Durable (non-`--light`) prototype directory search, ported from the legacy
 * `prototype-cli`'s `_proto_dir_search`: walk up from cwd to the repo
 * toplevel, then check every worktree of the same repo, for an existing
 * `.agents/prototype/<name>`. Falls back to `<cwd>/.agents/prototype/<name>`
 * when nothing exists yet; throws when more than one candidate exists.
 */
async function searchDurableDir(name: string, cwd: string): Promise<string> {
	const candidates: string[] = [];
	const seen = new Set<string>();
	const consider = async (dir: string): Promise<void> => {
		if (seen.has(dir)) return;
		seen.add(dir);
		if (await pathExists(dir)) candidates.push(dir);
	};

	const top = repoToplevel(cwd);
	let walk = resolve(cwd);
	while (true) {
		await consider(join(walk, ".agents", "prototype", name));
		if (!top || walk === top) break;
		const parent = dirname(walk);
		if (parent === walk) break;
		walk = parent;
	}

	if (top) {
		for (const worktree of worktreePaths(cwd)) {
			await consider(join(worktree, ".agents", "prototype", name));
		}
	}

	if (candidates.length === 0) {
		return join(resolve(cwd), ".agents", "prototype", name);
	}
	if (candidates.length === 1) return candidates[0];
	throw new AmbiguousPrototypeError(name, candidates);
}

/**
 * Resolve the prototype working directory for `name`. Durable mode searches
 * the current repo's worktrees for an existing copy (see `searchDurableDir`);
 * `--light` uses a scratch directory scoped to the caller's cwd, matching the
 * legacy shell's `ai_scratch_dir prototype cwd` bucket.
 */
export async function prototypeDir(
	name: string,
	opts: PrototypeDirOptions = {},
): Promise<string> {
	const cwd = opts.cwd ?? process.cwd();
	if (opts.light) return join(scratchDir("prototype", { cwd }), name);
	return searchDurableDir(name, cwd);
}

export const selectionPath = (name: string, opts?: PrototypeDirOptions) =>
	prototypeDir(name, opts).then((dir) => join(dir, ".selection"));
export const rejectPath = (name: string, opts?: PrototypeDirOptions) =>
	prototypeDir(name, opts).then((dir) => join(dir, ".reject"));
export const notesPath = (name: string, opts?: PrototypeDirOptions) =>
	prototypeDir(name, opts).then((dir) => join(dir, ".notes"));
export const decisionPath = (name: string, opts?: PrototypeDirOptions) =>
	prototypeDir(name, opts).then((dir) => join(dir, ".decision"));
export const reloadPath = (name: string, opts?: PrototypeDirOptions) =>
	prototypeDir(name, opts).then((dir) => join(dir, ".reload"));
export const changesPath = (name: string, opts?: PrototypeDirOptions) =>
	prototypeDir(name, opts).then((dir) => join(dir, ".changes"));
