import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evictFromPageCache } from "../src/node/page-cache";

const cache = join(import.meta.dir, "..", "..", "..", "node_modules", ".cache");
mkdirSync(cache, { recursive: true });
const dir = mkdtempSync(join(cache, "dg-page-cache-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const hasFincore = process.platform === "linux" && Bun.spawnSync(["fincore", "--version"], { stderr: "ignore" }).exitCode === 0;

function residentBytes(path: string): number {
	const out = Bun.spawnSync(["fincore", "--bytes", "--noheadings", "--output", "RES", path]).stdout.toString();
	return Number(out.trim());
}

describe("evictFromPageCache", () => {
	test.if(hasFincore)("drops a freshly written file from the page cache", () => {
		const file = join(dir, "fresh.bin");
		writeFileSync(file, new Uint8Array(4 * 1024 * 1024).fill(7));
		expect(residentBytes(file)).toBeGreaterThan(0);
		expect(evictFromPageCache(file)).toBe(true);
		expect(residentBytes(file)).toBe(0);
	});

	test("returns false for a missing file instead of throwing", () => {
		expect(evictFromPageCache(join(dir, "missing.bin"))).toBe(false);
	});
});
