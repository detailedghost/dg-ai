import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isAlive } from "@dg/common/node";
import { makeTempDir } from "./git-repo-fixtures";

const COMPILED_PREFIX = "dg-skills-compiled-";
const OWNER_PID_FILE = "owner.pid";
const STALE_AFTER_MS = 60 * 60 * 1000;

let compiled: string | undefined;
let currentRoot: string | undefined;

function cleanup(): void {
	if (currentRoot) rmSync(currentRoot, { recursive: true, force: true });
}

process.once("exit", cleanup);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		cleanup();
		process.exit(signal === "SIGINT" ? 130 : 143);
	});
}

function isStale(dir: string, now: number): boolean {
	try {
		const pid = Number.parseInt(readFileSync(join(dir, OWNER_PID_FILE), "utf8"), 10);
		if (Number.isSafeInteger(pid) && pid > 1) return !isAlive(pid);
	} catch {}
	return now - statSync(dir).mtimeMs > STALE_AFTER_MS;
}

/** Remove dead-run `dg-skills-compiled-*` dirs from a prior test process that never got to clean up after itself. */
export function sweepStaleCompiledDirs(root: string, keep: string, now = Date.now()): void {
	const keepName = basename(keep);
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return;
	}
	for (const name of entries) {
		if (!name.startsWith(COMPILED_PREFIX) || name === keepName) continue;
		const dir = join(root, name);
		try {
			if (isStale(dir, now)) rmSync(dir, { recursive: true, force: true });
		} catch {}
	}
}

/** Compile dg-skills once per test run into a path containing a quote and a space. */
export function buildCompiledBinary(): string {
	if (compiled) return compiled;
	const root = makeTempDir(COMPILED_PREFIX);
	currentRoot = root;
	writeFileSync(join(root, OWNER_PID_FILE), String(process.pid));
	sweepStaleCompiledDirs(dirname(root), root);
	const binary = join(root, "moved ' install", "dg-skills");
	mkdirSync(dirname(binary), { recursive: true });
	const build = Bun.spawnSync(
		[process.execPath, join(import.meta.dir, "../build.ts"), "--outfile", binary],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (build.exitCode !== 0) {
		cleanup();
		currentRoot = undefined;
		throw new Error(build.stderr.toString());
	}
	compiled = binary;
	return binary;
}
