import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildPages } from "../../pages/build";
import { hashBundle, playwrightMetadata } from "../../skills-cli/build";

export const ROOT = join(import.meta.dir, "..");
const PKG = join(ROOT, "..");
const ENTRY = join(ROOT, "src", "dg.ts");
const EXTERNAL = ["chromium-bidi", "chromium-bidi/*"];
const NAMESPACE = "dg-chunk";

interface NamedChunk {
	name: string;
	specifier: RegExp;
	importer?: RegExp;
	target: () => string;
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

export const NAMED_CHUNKS_PLUGIN = "named-chunks";

/** Routes each heavy dependency through a virtual module so its chunk gets a stable name. */
const namedChunks: Bun.BunPlugin = {
	name: NAMED_CHUNKS_PLUGIN,
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
			return { contents: `export * from ${JSON.stringify(chunk.target())};`, loader: "js", resolveDir: PKG };
		});
	},
};

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

export async function sharedOptions() {
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

export type SharedOptions = Awaited<ReturnType<typeof sharedOptions>>;
