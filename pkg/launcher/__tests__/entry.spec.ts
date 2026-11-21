import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");

describe("compiled dg entry", () => {
	test("runs dispatch without an import.meta.main guard, which is false in a Windows compiled exe", () => {
		const entry = readFileSync(join(SRC, "dg.ts"), "utf8");
		expect(entry).not.toContain("import.meta.main");
		expect(entry).toContain("dispatch(process.argv.slice(2), process.argv0)");
	});

	test("dispatch imports without running, so tests can call it", async () => {
		const { dispatch } = await import("../src/dispatch");
		expect(typeof dispatch).toBe("function");
	});
});
