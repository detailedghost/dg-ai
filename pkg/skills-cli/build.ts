import { createHash } from "node:crypto";

/** Playwright computes these requires at runtime; make them static so Bun embeds the JSON. */
export const playwrightMetadata: Bun.BunPlugin = {
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

/**
 * Hash every module the entrypoint actually bundles, not just its own file,
 * so the build stamp changes when any dependency it pulls in changes too.
 * Output order from `Bun.build` isn't guaranteed stable, so outputs are
 * sorted by path before hashing.
 */
export async function hashBundle(
	entrypoint: string,
	plugins: Bun.BunPlugin[],
): Promise<string> {
	const result = await Bun.build({
		entrypoints: [entrypoint],
		target: "bun",
		external: ["chromium-bidi", "chromium-bidi/*"],
		plugins,
	});
	if (!result.success)
		throw new AggregateError(result.logs, "Skills CLI build-hash pass failed.");
	const hash = createHash("sha1");
	for (const output of [...result.outputs].sort((a, b) =>
		a.path.localeCompare(b.path),
	))
		hash.update(new Uint8Array(await output.arrayBuffer()));
	return hash.digest("hex");
}
