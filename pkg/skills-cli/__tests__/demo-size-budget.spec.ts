import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const DEMO_CHUNK_BUDGET_BYTES = 400 * 1024;

async function bundle(entry: string): Promise<string> {
	const result = await Bun.build({
		entrypoints: [join(SRC, entry)],
		target: "bun",
		external: ["playwright-core", "playwright-core/*", "chromium-bidi", "chromium-bidi/*"],
	});
	expect(result.success).toBe(true);
	return (await Promise.all(result.outputs.map((out) => out.text()))).join("\n");
}

describe("demo recorder bundle", () => {
	test("the demo chunk stays under 400 KB", async () => {
		const code = await bundle("demo/local.ts");
		expect(code).toContain("dg-demo-caption");
		expect(Buffer.byteLength(code)).toBeLessThan(DEMO_CHUNK_BUDGET_BYTES);
	});

	test("the recorder is not part of the stash chunk", async () => {
		const code = await bundle("commands/stash.ts");
		expect(code).not.toContain("dg-demo-caption");
	});
});
