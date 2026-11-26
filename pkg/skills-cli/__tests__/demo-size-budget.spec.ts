import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const DEMO_CHUNK_BUDGET_KB = 400;
const DEMO_CHUNK_BUDGET_BYTES = DEMO_CHUNK_BUDGET_KB * 1024;
const PLAN_PARSER_MARKER = "markedjs";
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

async function measure(entry: string): Promise<{ bytes: number; code: string; all: string }> {
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
	const all = (await Promise.all(result.outputs.map((out) => out.text()))).join("\n");
	return { bytes: Buffer.byteLength(code), code, all };
}

describe("demo recorder bundle", () => {
	let demo: Awaited<ReturnType<typeof measure>>;
	beforeAll(async () => {
		demo = await measure("demo/local.ts");
	});

	test(`the demo chunk and every chunk it loads up front stay under ${DEMO_CHUNK_BUDGET_KB} KB`, async () => {
		expect(demo.code).toContain("dg-demo-caption");
		expect(demo.bytes).toBeLessThan(DEMO_CHUNK_BUDGET_BYTES);
	});

	test("the markdown plan parser loads on demand, not with the demo chunk", async () => {
		expect(demo.code).not.toContain(PLAN_PARSER_MARKER);
		expect(demo.all).toContain(PLAN_PARSER_MARKER);
	});

	test("the recorder is not part of the stash chunk", async () => {
		const { all } = await measure("commands/stash.ts");
		expect(all).not.toContain("dg-demo-caption");
	});
});
