import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { companionAssetName } from "@dg/common/node/companion";
import { playwrightMetadata } from "../../skills-cli/build";
import { NAMED_CHUNKS_PLUGIN, ROOT } from "./options";

function walk(dir: string): string[] {
	return readdirSync(dir).sort().flatMap((name) => {
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

const SKILLS_CLI = join(ROOT, "..", "skills-cli");

const COMPANION_ENTRIES = {
	pw: 'export * from "playwright-core";\nexport { registry } from "playwright-core/lib/coreBundle";\n',
	db: 'import pg from "pg";\nimport snowflake from "snowflake-sdk";\nexport { pg, snowflake };\n',
} as const;

const COMPANION_PACKAGES = ["playwright-core", "playwright-core/*", "pg", "snowflake-sdk"];

export const companionNames = Object.keys(COMPANION_ENTRIES) as Array<keyof typeof COMPANION_ENTRIES>;

/** Compiled build options with the companion packages left out and the loader told to fetch them. */
export function excludeCompanions<T extends { external: string[]; define: Record<string, string>; plugins: Bun.BunPlugin[] }>(options: T): T {
	return {
		...options,
		plugins: options.plugins.filter((plugin) => plugin.name !== NAMED_CHUNKS_PLUGIN),
		external: [...options.external, ...COMPANION_PACKAGES],
		define: { ...options.define, "process.env.DG_COMPANIONS_EXTERNAL": JSON.stringify("1") },
	};
}

export async function buildCompanions(outdir: string, version: string): Promise<string[]> {
	mkdirSync(outdir, { recursive: true });
	return Promise.all(
		companionNames.map(async (name) => {
			const entry = join(SKILLS_CLI, `companion-${name}.ts`);
			const result = await Bun.build({
				entrypoints: [entry],
				files: { [entry]: COMPANION_ENTRIES[name] },
				target: "bun",
				minify: true,
				external: ["chromium-bidi", "chromium-bidi/*"],
				plugins: [playwrightMetadata],
				naming: "index.js",
			});
			if (!result.success) throw new AggregateError(result.logs, `Companion ${name} build failed.`);
			const [output, ...extra] = result.outputs;
			if (!output || extra.length > 0) throw new Error(`Companion ${name} build emitted ${result.outputs.length} outputs, expected 1.`);
			const index = new Uint8Array(await output.arrayBuffer());
			const tarball = join(outdir, companionAssetName(name, version));
			await Bun.write(tarball, Bun.zstdCompressSync(await new Bun.Archive({ "index.js": index }).bytes(), { level: 19 }));
			return tarball;
		}),
	);
}
