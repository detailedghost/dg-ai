import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { isAlive } from "@dg/common/node";
import { makeTempDir } from "./git-repo-fixtures";

const COMPILED_PREFIX = "dg-skills-compiled-";
const STALE_AFTER_MS = 60 * 60 * 1000;

let compiled: string | undefined;

function isStale(dir: string, now: number): boolean {
	try {
		const pid = Number.parseInt(readFileSync(join(dir, "owner.pid"), "utf8"), 10);
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
	writeFileSync(join(root, "owner.pid"), String(process.pid));
	sweepStaleCompiledDirs(tmpdir(), root);
	const cleanup = () => rmSync(root, { recursive: true, force: true });
	process.once("exit", cleanup);
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.once(signal, () => {
			cleanup();
			process.exit(signal === "SIGINT" ? 130 : 143);
		});
	}
	const binary = join(root, "moved ' install", "dg-skills");
	mkdirSync(dirname(binary), { recursive: true });
	const build = Bun.spawnSync(
		[process.execPath, join(import.meta.dir, "../build.ts"), "--outfile", binary],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (build.exitCode !== 0) {
		cleanup();
		throw new Error(build.stderr.toString());
	}
	compiled = binary;
	return binary;
}
