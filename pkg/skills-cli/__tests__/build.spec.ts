import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashBundle } from "../build";

describe("hashBundle", () => {
	test("changes when a non-entry module the entrypoint imports changes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "dg-skills-hash-"));
		const entrypoint = join(dir, "entry.ts");
		const dependency = join(dir, "dep.ts");
		try {
			writeFileSync(dependency, 'export const value = "first";\n');
			writeFileSync(
				entrypoint,
				'import { value } from "./dep";\nconsole.log(value);\n',
			);
			const before = await hashBundle(entrypoint, []);

			writeFileSync(dependency, 'export const value = "second";\n');
			const after = await hashBundle(entrypoint, []);

			expect(after).not.toBe(before);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
