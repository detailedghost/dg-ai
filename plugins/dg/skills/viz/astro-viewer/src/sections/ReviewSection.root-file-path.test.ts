import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * the review command's groupDir() reports "." as the grouping key for a repo-root file. It is a key, not a
 * path prefix, so the file card must not slice its length off the path — that ate the first two
 * characters of every root-level filename ("README.md" rendered as "./ADME.md").
 */

const FILE_PATH = join(import.meta.dir, "ReviewSection.astro");

/** Mirrors fileCardHtml's dirPart/base split, extracted from source so it cannot drift. */
function splitPath(file: { path: string; dir: string }): { dirPart: string; base: string } {
	const src = readFileSync(FILE_PATH, "utf-8");
	const start = src.indexOf("const dirPart = file.dir");
	if (start === -1) throw new Error("dirPart derivation not found in ReviewSection.astro");
	const end = src.indexOf("\n", src.indexOf("const base = file.path", start));
	const snippet = src.slice(start, end);
	const transpiler = new Bun.Transpiler({ loader: "ts" });
	const js = transpiler.transformSync(snippet);
	return new Function("file", `${js}\nreturn { dirPart, base };`)(file) as { dirPart: string; base: string };
}

describe("ReviewSection file card — path split", () => {
	it("renders a repo-root filename whole, with no './' prefix", () => {
		const { dirPart, base } = splitPath({ path: "README.md", dir: "." });

		expect(base).toBe("README.md");
		expect(dirPart).toBe("");
	});

	it("keeps single-character root filenames intact", () => {
		expect(splitPath({ path: "b.txt", dir: "." }).base).toBe("b.txt");
		expect(splitPath({ path: "greet.js", dir: "." }).base).toBe("greet.js");
	});

	it("still splits a nested path into dir prefix and basename", () => {
		const { dirPart, base } = splitPath({ path: "src/sections/ReviewSection.astro", dir: "src/sections" });

		expect(dirPart).toBe("src/sections/");
		expect(base).toBe("ReviewSection.astro");
	});

	it("falls back to the whole path when dir is not actually a prefix", () => {
		const { base } = splitPath({ path: "src/app.ts", dir: "lib/other" });

		expect(base).toBe("src/app.ts");
	});

	it("handles an empty dir without dropping characters", () => {
		const { dirPart, base } = splitPath({ path: "package.json", dir: "" });

		expect(dirPart).toBe("");
		expect(base).toBe("package.json");
	});

	it("reassembles to the original path in every case", () => {
		const cases = [
			{ path: "README.md", dir: "." },
			{ path: "src/sections/ReviewSection.astro", dir: "src/sections" },
			{ path: "package.json", dir: "" },
			{ path: "a/b/c/deep.ts", dir: "a/b" },
		];
		for (const c of cases) {
			const { dirPart, base } = splitPath(c);
			expect(dirPart + base).toBe(c.path);
		}
	});
});
