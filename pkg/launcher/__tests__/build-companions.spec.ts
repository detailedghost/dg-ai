import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCompanions } from "../build/companions";
import { buildCompiled } from "../build/compile";

setDefaultTimeout(240_000);

const outdir = mkdtempSync(join(tmpdir(), "dg-companions-"));
afterAll(() => rmSync(outdir, { recursive: true, force: true }));

async function entries(file: string): Promise<Map<string, string>> {
	const tar = Bun.zstdDecompressSync(readFileSync(file));
	const files = await new Bun.Archive(tar).files();
	const out = new Map<string, string>();
	for (const [path, blob] of files) out.set(path, await blob.text());
	return out;
}

describe("companion bundles", () => {
	test("emits dg-pw and dg-db tar.zst files named with the version", async () => {
		const files = await buildCompanions(outdir, "1.2.3");
		expect(files.map((file) => file.slice(outdir.length + 1)).sort()).toEqual(["dg-db-1.2.3.tar.zst", "dg-pw-1.2.3.tar.zst"]);
	});

	test("the pw companion carries an index.js that exports chromium", async () => {
		const index = (await entries(join(outdir, "dg-pw-1.2.3.tar.zst"))).get("index.js") ?? "";
		expect(index).toContain("chromium");
	});

	test("the db companion carries an index.js that exports pg and snowflake", async () => {
		const index = (await entries(join(outdir, "dg-db-1.2.3.tar.zst"))).get("index.js") ?? "";
		expect(index).toMatch(/export\s*\{[^}]*\bpg\b/);
		expect(index).toMatch(/export\s*\{[^}]*\bsnowflake\b/);
	});

	test("a compiled build that excludes companions is smaller than one that embeds them", async () => {
		const embedded = await buildCompiled({ target: "linux-x64", outfile: join(outdir, "full", "dg") });
		const slim = await buildCompiled({ target: "linux-x64", outfile: join(outdir, "slim", "dg"), excludeCompanions: true });
		const saved = statSync(embedded).size - statSync(slim).size;
		expect(saved).toBeGreaterThan(3_000_000);
	});
});
