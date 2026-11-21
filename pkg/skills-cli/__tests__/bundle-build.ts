import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { onTestRunEnd } from "./test-run-end";

export interface BuiltBundle {
	bun: string;
	entry: string;
	lib: string;
	dist: string;
}

const LAUNCHER = join(import.meta.dir, "..", "..", "launcher");

let built: BuiltBundle | undefined;
let outdir: string | undefined;

function removeBundle(): void {
	if (outdir) rmSync(outdir, { recursive: true, force: true });
}

process.once("exit", removeBundle);
onTestRunEnd(removeBundle);

/** Builds the bundle once per run into a temp dir. */
export function buildBundle(): BuiltBundle {
	if (built) return built;
	const dist = mkdtempSync(join(tmpdir(), "dg-bundle-"));
	outdir = dist;
	const build = Bun.spawnSync(
		[process.execPath, join(LAUNCHER, "build.ts"), "--outdir", dist],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (build.exitCode !== 0) throw new Error(build.stderr.toString());
	const lib = join(dist, "lib");
	built = { bun: process.execPath, entry: join(lib, "dg.js"), lib, dist };
	return built;
}

const GROUP: Record<string, readonly string[]> = { "dg-skills": ["skills"], "dg-agent": ["agent"], "dg-daemon": ["daemon"], dg: [] };

/** The dg words that run one program: `skills`, `agent`, `daemon`, or none for dg. */
export function groupWords(program: string): readonly string[] {
	const words = GROUP[program];
	if (!words) throw new Error(`unknown program ${program}`);
	return words;
}

/** Argv prefix that runs one program of the built bundle. */
export function bundleCommand(program: string): string[] {
	const { bun, entry } = buildBundle();
	return [bun, entry, ...groupWords(program)];
}

/** Argv prefix for a copy of the lib dir under a quoted, spaced path. */
export function relocatedBundleCommand(parent: string, program: string): string[] {
	const { bun, lib } = buildBundle();
	const moved = join(parent, "moved ' install", "lib");
	mkdirSync(join(moved, ".."), { recursive: true });
	cpSync(lib, moved, { recursive: true });
	return [bun, join(moved, "dg.js"), ...groupWords(program)];
}

function quote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Writes a POSIX shim at `path` that runs one program of a copied lib dir; `dg` runs the flat commands. */
export function installBundleShim(path: string, program = "dg-skills"): string {
	const { bun, lib } = buildBundle();
	const moved = join(dirname(path), "lib");
	mkdirSync(dirname(path), { recursive: true });
	cpSync(lib, moved, { recursive: true });
	writeFileSync(path, `#!/bin/sh\nexec ${quote(bun)} ${quote(join(moved, "dg.js"))} ${groupWords(program).map(quote).join(" ")} "$@"\n`);
	chmodSync(path, 0o755);
	return path;
}
