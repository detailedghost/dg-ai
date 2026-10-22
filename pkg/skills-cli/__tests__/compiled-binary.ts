import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeTempDir } from "./git-repo-fixtures";

let compiled: string | undefined;

/** Compile dg-skills once per test run into a path containing a quote and a space. */
export function buildCompiledBinary(): string {
	if (compiled) return compiled;
	const root = makeTempDir("dg-skills-compiled-");
	process.once("exit", () => rmSync(root, { recursive: true, force: true }));
	const binary = join(root, "moved ' install", "dg-skills");
	mkdirSync(dirname(binary), { recursive: true });
	const build = Bun.spawnSync(
		[process.execPath, join(import.meta.dir, "../build.ts"), "--outfile", binary],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (build.exitCode !== 0) throw new Error(build.stderr.toString());
	compiled = binary;
	return binary;
}
