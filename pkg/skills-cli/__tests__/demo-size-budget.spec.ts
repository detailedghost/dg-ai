import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const DEMO_CHUNK_BUDGET_KB = 400;
const DEMO_CHUNK_BUDGET_BYTES = DEMO_CHUNK_BUDGET_KB * 1024;
const COMPANION_PACKAGES = ["playwright-core", "playwright-core/*", "pg", "snowflake-sdk"];

async function build(entry: string) {
	const result = await Bun.build({
		entrypoints: [join(SRC, entry)],
		target: "bun",
		splitting: true,
		metafile: true,
		external: [...COMPANION_PACKAGES, "chromium-bidi", "chromium-bidi/*"],
	});
	expect(result.success).toBe(true);
	return result;
}

async function bundle(entry: string): Promise<string> {
	const result = await build(entry);
	return (await Promise.all(result.outputs.map((out) => out.text()))).join("\n");
}

async function eagerBytes(entry: string): Promise<{ bytes: number; code: string }> {
	const result = await build(entry);
	const outputs = result.metafile?.outputs ?? {};
	const entryPath = Object.keys(outputs).find((path) => outputs[path]?.entryPoint !== undefined);
	if (entryPath === undefined) throw new Error(`no entry output for ${entry}`);
	const eager = new Set<string>();
	const visit = (path: string) => {
		if (eager.has(path)) return;
		eager.add(path);
		for (const link of outputs[path]?.imports ?? []) if (link.kind === "import-statement") visit(link.path);
	};
	visit(entryPath);
	const texts = await Promise.all(
		result.outputs.filter((out) => eager.has(`./${out.path.replace(/^\.\//, "")}`)).map((out) => out.text()),
	);
	const code = texts.join("\n");
	if (code === "") throw new Error(`no eager code found for ${entry}`);
	return { bytes: Buffer.byteLength(code), code };
}

describe("demo recorder bundle", () => {
	test(`the demo chunk and every chunk it loads up front stay under ${DEMO_CHUNK_BUDGET_KB} KB`, async () => {
		const { bytes, code } = await eagerBytes("demo/local.ts");
		expect(code).toContain("dg-demo-caption");
		expect(bytes).toBeLessThan(DEMO_CHUNK_BUDGET_BYTES);
	});

	test("the markdown plan parser loads on demand, not with the demo chunk", async () => {
		const { code } = await eagerBytes("demo/local.ts");
		expect(code).not.toContain("markedjs");
		expect(await bundle("demo/local.ts")).toContain("markedjs");
	});

	test("the recorder is not part of the stash chunk", async () => {
		const code = await bundle("commands/stash.ts");
		expect(code).not.toContain("dg-demo-caption");
	});
});
