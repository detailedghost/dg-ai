import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? walk(path) : [path];
	});
}

export async function packLib(lib: string, outdir: string, version: string): Promise<string> {
	const files: Record<string, Uint8Array> = {};
	for (const file of walk(lib)) files[relative(lib, file).split(sep).join("/")] = readFileSync(file);
	const tarball = join(outdir, `dg-lib-${version}.tar.gz`);
	mkdirSync(outdir, { recursive: true });
	await Bun.write(tarball, await new Bun.Archive(files, { compress: "gzip" }).bytes());
	return tarball;
}
