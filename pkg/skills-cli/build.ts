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
		// The connect flow uses Chrome's CDP transport, never the optional BiDi transport.
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
		target: values.target as Bun.Build.CompileTarget | undefined,
	});
}
