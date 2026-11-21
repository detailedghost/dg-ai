import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { parseArgs } from "node:util";
import { buildPages } from "../pages/build";
import { hashBundle, playwrightMetadata } from "../skills-cli/build";
import { compiledAssetName } from "../skills-cli/src/utils/lib";

export { compiledAssetName };

const ROOT = import.meta.dir;
const PKG = join(ROOT, "..");
const ENTRY = join(ROOT, "src", "dg.ts");
const EXTERNAL = ["chromium-bidi", "chromium-bidi/*"];
const NAMESPACE = "dg-chunk";

interface NamedChunk {
	name: string;
	specifier: RegExp;
	importer?: RegExp;
	target: (importer: string) => string;
}

const NAMED_CHUNKS: NamedChunk[] = [
	{
		name: "pw",
		specifier: /^playwright-core$/,
		target: () => Bun.resolveSync("playwright-core", join(PKG, "skills-cli")),
	},
	{
		name: "inbox",
		specifier: /^\.\.\/inbox\/cli$/,
		importer: /[/\\]skills-cli[/\\]src[/\\]commands[/\\]inbox\.ts$/,
		target: () => join(PKG, "skills-cli", "src", "inbox", "cli.ts"),
	},
	{
		name: "nostr",
		specifier: /^\.\/commands$/,
		importer: /[/\\]dg-agent[/\\]src[/\\]phone[/\\]register\.ts$/,
		target: () => join(PKG, "dg-agent", "src", "phone", "commands.ts"),
	},
];

/** Routes each heavy dependency through a virtual module so its chunk gets a stable name. */
const namedChunks: Bun.BunPlugin = {
	name: "named-chunks",
	setup(build) {
		for (const chunk of NAMED_CHUNKS) {
			build.onResolve({ filter: chunk.specifier, namespace: "file" }, ({ importer }) => {
				if (chunk.importer && !chunk.importer.test(importer)) return undefined;
				return { path: chunk.name, namespace: NAMESPACE };
			});
		}
		build.onLoad({ filter: /.*/, namespace: NAMESPACE }, ({ path }) => {
			const chunk = NAMED_CHUNKS.find((candidate) => candidate.name === path);
			if (!chunk) throw new Error(`Unknown named chunk ${path}`);
			return { contents: `export * from ${JSON.stringify(chunk.target(""))};`, loader: "js", resolveDir: PKG };
		});
	},
};

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? walk(path) : [path];
	});
}

function revision(): string | undefined {
	const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT, stdout: "pipe", stderr: "ignore" });
	return result.exitCode === 0 ? result.stdout.toString().trim() : undefined;
}

/** The bun compile target for each runtime.json platform key; the release asset is `dg-<key>[.exe]`. */
export const COMPILE_TARGETS = {
	"linux-x64": "bun-linux-x64",
	"linux-x64-baseline": "bun-linux-x64-baseline",
	"linux-arm64": "bun-linux-arm64",
	"darwin-x64": "bun-darwin-x64",
	"darwin-arm64": "bun-darwin-arm64",
	"windows-x64": "bun-windows-x64",
	"windows-x64-baseline": "bun-windows-x64-baseline",
	"windows-arm64": "bun-windows-arm64",
} as const;

export type CompileKey = keyof typeof COMPILE_TARGETS;

async function sharedOptions() {
	const plugins = [playwrightMetadata, namedChunks];
	await buildPages();
	const { version } = JSON.parse(readFileSync(join(PKG, "skills-cli", "package.json"), "utf8")) as { version: string };
	const sha = process.env.DG_BUILD_SHA ?? revision() ?? (await hashBundle(ENTRY, plugins));
	const options = {
		entrypoints: [ENTRY],
		target: "bun" as const,
		splitting: true,
		minify: true,
		external: EXTERNAL,
		plugins,
		define: {
			"process.env.DG_BUILD_VERSION": JSON.stringify(version),
			"process.env.DG_BUILD_SHA": JSON.stringify(sha),
		},
	};
	return { options, version, sha };
}

type SharedOptions = Awaited<ReturnType<typeof sharedOptions>>;

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
	const result = await Bun.build({ ...options, compile: { target: COMPILE_TARGETS[target], outfile } });
	if (!result.success) throw new AggregateError(result.logs, `Compiled dg build failed for ${target}.`);
	return outfile;
}

export async function buildLauncher(outdir: string): Promise<{ lib: string; tarball: string }> {
	const { options, version, sha } = await sharedOptions();
	const lib = join(outdir, "lib");
	rmSync(outdir, { recursive: true, force: true });
	const result = await Bun.build({ ...options, outdir: lib, naming: { chunk: "chunks/[name]-[hash].js" } });
	if (!result.success) throw new AggregateError(result.logs, "Launcher bundle build failed.");

	writeFileSync(join(lib, "build.json"), `${JSON.stringify({ version, sha })}\n`);
	const files: Record<string, Uint8Array> = {};
	for (const file of walk(lib)) files[relative(lib, file).split(sep).join("/")] = readFileSync(file);
	const tarball = join(outdir, `dg-lib-${version}.tar.gz`);
	mkdirSync(outdir, { recursive: true });
	await Bun.write(tarball, await new Bun.Archive(files, { compress: "gzip" }).bytes());
	return { lib, tarball };
}

const isCompileKey = (key: string): key is CompileKey => Object.hasOwn(COMPILE_TARGETS, key);

if (import.meta.main) {
	const { values } = parseArgs({
		args: Bun.argv.slice(2),
		options: { outdir: { type: "string" }, compiled: { type: "string", multiple: true } },
	});
	const outdir = values.outdir ?? join(ROOT, "dist");
	if (!values.compiled) await buildLauncher(outdir);
	else {
		const keys = values.compiled.includes("all") ? Object.keys(COMPILE_TARGETS) : values.compiled;
		const targets = keys.map((key) => {
			if (!isCompileKey(key)) throw new Error(`unknown compile target ${key}; expected all or ${Object.keys(COMPILE_TARGETS).join(", ")}`);
			return key;
		});
		const shared = await sharedOptions();
		for (const target of targets) {
			console.log(await buildCompiled({ target, outfile: join(outdir, compiledAssetName(target)), shared }));
		}
	}
}
