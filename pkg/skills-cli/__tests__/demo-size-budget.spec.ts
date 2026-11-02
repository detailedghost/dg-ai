import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { playerScript } from "../src/demo/player-asset";

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

describe("embedded player asset", () => {
	test("is non-empty and defines window.__dgTour", () => {
		const js = playerScript();
		expect(js.length).toBeGreaterThan(1000);
		expect(js).toContain("__dgTour");
	});

	test("is part of the demo chunk, which stays under 400 KB", async () => {
		const code = await bundle("demo/local.ts");
		expect(code).toContain("__dgTour");
		expect(Buffer.byteLength(code)).toBeLessThan(DEMO_CHUNK_BUDGET_BYTES);
	});

	test("is not part of the stash chunk", async () => {
		const code = await bundle("commands/stash.ts");
		expect(code).not.toContain("__dgTour");
		expect(code).not.toContain(playerScript().slice(0, 200));
	});
});
