import { join } from "node:path";
import { parseArgs } from "node:util";

/** Playwright computes these requires at runtime; make them static so Bun embeds the JSON. */
const playwrightMetadata: Bun.BunPlugin = {
	name: "playwright-metadata",
	setup(build) {
		build.onLoad(
			{ filter: /[/\\]playwright-core[/\\]lib[/\\]coreBundle\.js$/ },
			async ({ path }) => {
				const source = await Bun.file(path).text();
				let replaced = 0;
				const contents = source.replace(
					/require\(import_path\d+\.default\.join\(packageRoot, "(package|browsers)\.json"\)\)/g,
					(_match, name: string) => {
						replaced++;
						return `require("../${name}.json")`;
					},
				);
				if (replaced !== 2)
					throw new Error(
						"Playwright's metadata loading changed; update the standalone build adapter.",
					);
				return { contents, loader: "js" };
			},
		);
	},
};

const COMPILE_TARGETS = [
	"bun-linux-x64",
	"bun-linux-arm64",
	"bun-darwin-x64",
	"bun-darwin-arm64",
	"bun-windows-x64",
	"bun-windows-arm64",
] as const satisfies readonly Bun.Build.CompileTarget[];

function parseTarget(
	value: string | undefined,
): Bun.Build.CompileTarget | undefined {
	if (value === undefined) return undefined;
	const target = COMPILE_TARGETS.find((known) => known === value);
	if (!target)
		throw new Error(
			`Unknown --target ${value}. Use one of: ${COMPILE_TARGETS.join(", ")}.`,
		);
	return target;
}

export async function buildSkillsCli(options: {
	outfile: string;
	target?: Bun.Build.CompileTarget;
	entrypoint?: string;
	plugins?: Bun.BunPlugin[];
}): Promise<void> {
	const result = await Bun.build({
		entrypoints: [options.entrypoint ?? join(import.meta.dir, "src/index.ts")],
		compile: {
			outfile: options.outfile,
			...(options.target ? { target: options.target } : {}),
		},
		external: ["chromium-bidi", "chromium-bidi/*"],
		plugins: [playwrightMetadata, ...(options.plugins ?? [])],
	});
	if (!result.success)
		throw new AggregateError(result.logs, "Skills CLI compilation failed.");
}

if (import.meta.main) {
	const { values } = parseArgs({
		args: Bun.argv.slice(2),
		options: { outfile: { type: "string" }, target: { type: "string" } },
	});
	await buildSkillsCli({
		outfile: values.outfile ?? join(import.meta.dir, "dist/dg-skills"),
		target: parseTarget(values.target),
	});
}
