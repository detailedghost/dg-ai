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

	test("dispatch lives in a module with no top-level side effect, so tests can import it", () => {
		const module = readFileSync(join(SRC, "dispatch.ts"), "utf8");
		expect(module).not.toContain("exitAfterDrain");
		expect(module).toContain("export async function dispatch(");
	});
});
