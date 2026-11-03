import { beforeAll, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";
import { buildPages } from "../build";

const BUDGET_BYTES = 150 * 1024;
const dist = join(import.meta.dir, "../dist");
const ASSETS = ["chat.html", "chat.js", "board.html", "board.js"];

beforeAll(async () => {
	await buildPages();
});

test("chat and board page assets together stay under the size budget", () => {
	const sizes = ASSETS.map((name) => statSync(join(dist, name)).size);
	for (const size of sizes) expect(size).toBeGreaterThan(0);
	expect(sizes.reduce((total, size) => total + size, 0)).toBeLessThan(
		BUDGET_BYTES,
	);
});
