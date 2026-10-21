import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { repoRoot, scratchDir } from "@dg/common/node";

export interface ProtoLocation {
	cwd: string;
	light: boolean;
}

export interface SentinelPaths {
	dir: string;
	selection: string;
	notes: string;
	reject: string;
	decision: string;
	reload: string;
	changes: string;
}

export function assertProtoName(name: string): string {
	if (!name || name === "." || name === ".." || /[/\\\0]/.test(name))
		throw new Error(`invalid prototype name: ${JSON.stringify(name)}`);
	return name;
}

function isDirectory(path: string): boolean {
	return existsSync(path) && statSync(path).isDirectory();
}

function worktreeRoots(cwd: string): string[] {
	const result = Bun.spawnSync(["git", "worktree", "list", "--porcelain"], {
		cwd,
		stderr: "ignore",
	});
	if (result.exitCode !== 0) return [];
	return result.stdout
		.toString()
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length));
}

function searchDurableDir(name: string, cwd: string): string {
	const top = repoRoot(cwd);
	const candidates: string[] = [];
	const add = (root: string) => {
		const candidate = join(root, ".agents", "prototype", name);
		if (isDirectory(candidate) && !candidates.includes(candidate))
			candidates.push(candidate);
	};

	let walk = cwd;
	while (true) {
		add(walk);
		if (!top || walk === top || walk === dirname(walk)) break;
		walk = dirname(walk);
	}
	if (top) for (const root of worktreeRoots(cwd)) add(root);

	if (candidates.length === 0) return join(cwd, ".agents", "prototype", name);
	if (candidates.length === 1) return candidates[0] as string;
	throw new Error(
		[
			`ambiguous prototype "${name}" — found under multiple roots:`,
			...candidates.map((candidate) => `  ${candidate}`),
			"run from inside the intended one, or remove the stale copy, to disambiguate",
		].join("\n"),
	);
}

/** Resolve the directory that holds a prototype's sentinels from an explicit working directory. */
export function protoDir(name: string, location: ProtoLocation): string {
	assertProtoName(name);
	const cwd = resolve(location.cwd);
	if (location.light) return join(scratchDir("prototype", { cwd }), name);
	return searchDurableDir(name, cwd);
}

export function sentinelPaths(dir: string): SentinelPaths {
	return {
		dir,
		selection: join(dir, ".selection"),
		notes: join(dir, ".notes"),
		reject: join(dir, ".reject"),
		decision: join(dir, ".decision"),
		reload: join(dir, ".reload"),
		changes: join(dir, ".changes"),
	};
}
