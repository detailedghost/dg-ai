import { readFileSync, writeFileSync } from "node:fs";

/** Writes each module the process loads to DG_LOAD_LOG, one path per line. */
const out = process.env.DG_LOAD_LOG;
if (out) {
	const seen = new Set<string>();
	const flush = () => {
		for (const path of Object.keys(require.cache)) seen.add(path);
		writeFileSync(out, `${[...seen].join("\n")}\n`);
	};
	setInterval(flush, 100).unref();
	Bun.plugin({
		name: "load-log",
		setup(build) {
			build.onLoad({ filter: /[/\\]pages[/\\]dist[/\\]/ }, ({ path }) => {
				seen.add(path);
				return { contents: `export default ${JSON.stringify(readFileSync(path, "utf8"))};`, loader: "js" };
			});
			build.onLoad({ filter: /\.json$/ }, ({ path }) => {
				seen.add(path);
				return { contents: `export default ${readFileSync(path, "utf8")};`, loader: "js" };
			});
			build.onLoad({ filter: /\.tsx?$/ }, ({ path }) => {
				seen.add(path);
				return { contents: readFileSync(path, "utf8"), loader: path.endsWith("x") ? "tsx" : "ts" };
			});
		},
	});
}
