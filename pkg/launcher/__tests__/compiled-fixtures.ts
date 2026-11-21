import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestRunEnd } from "../../skills-cli/__tests__/test-run-end";
import { type CompileKey, compiledAssetName } from "../build";

const LAUNCHER = join(import.meta.dir, "..");

let built: string | undefined;
let outdir: string | undefined;

function removeCompiled(): void {
	if (outdir) rmSync(outdir, { recursive: true, force: true });
}

process.once("exit", removeCompiled);
onTestRunEnd(removeCompiled);

/** The compile key of the machine that runs the tests. */
export function hostKey(): CompileKey {
	const os = process.platform === "win32" ? "windows" : process.platform;
	return `${os}-${process.arch}` as CompileKey;
}

/** Builds the compiled dg for this machine once per run into a temp dir. */
export function buildCompiledHost(): string {
	if (built) return built;
	const dist = mkdtempSync(join(tmpdir(), "dg-compiled-"));
	outdir = dist;
	const build = Bun.spawnSync([process.execPath, join(LAUNCHER, "build.ts"), "--outdir", dist, "--compiled", hostKey()], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (build.exitCode !== 0) throw new Error(build.stderr.toString());
	built = join(dist, compiledAssetName(hostKey()));
	return built;
}
