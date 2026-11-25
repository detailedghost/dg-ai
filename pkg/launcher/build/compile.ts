import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { packLib } from "./companions";
import { type CompileKey, COMPILE_TARGETS, type SharedOptions, sharedOptions } from "./options";
import { writeBuildInfo } from "./report";

/** Builds one compiled dg executable for `target` at `outfile`; pass `shared` to reuse one page build across targets. */
export async function buildCompiled({
	target,
	outfile,
	shared,
}: {
	target: CompileKey;
	outfile: string;
	shared?: SharedOptions;
}): Promise<string> {
	const { options } = shared ?? (await sharedOptions());
	mkdirSync(dirname(outfile), { recursive: true });
	const compile = { target: COMPILE_TARGETS[target], outfile, autoloadDotenv: false, autoloadBunfig: false };
	const result = await Bun.build({ ...options, compile });
	if (!result.success) throw new AggregateError(result.logs, `Compiled dg build failed for ${target}.`);
	return outfile;
}

export async function buildLauncher(outdir: string): Promise<{ lib: string; tarball: string }> {
	const { options, version, sha } = await sharedOptions();
	const lib = join(outdir, "lib");
	rmSync(outdir, { recursive: true, force: true });
	const result = await Bun.build({ ...options, outdir: lib, naming: { chunk: "chunks/[name]-[hash].js" } });
	if (!result.success) throw new AggregateError(result.logs, "Launcher bundle build failed.");

	writeBuildInfo(lib, { version, sha });
	const tarball = await packLib(lib, outdir, version);
	return { lib, tarball };
}
