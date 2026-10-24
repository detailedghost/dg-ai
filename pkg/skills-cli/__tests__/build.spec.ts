import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSkillsCli, hashBundle, playwrightMetadata } from "../build";

describe("buildSkillsCli", () => {
	test("--version reports a hash of the bundle, so a stale compiled binary is diagnosable", async () => {
		const dir = mkdtempSync(join(tmpdir(), "dg-skills-build-"));
		const outfile = join(dir, "dg-skills-test");
		try {
			await buildSkillsCli({ outfile });
			const entrypoint = join(import.meta.dir, "..", "src", "index.ts");
			const expected = await hashBundle(entrypoint, [playwrightMetadata]);
			const printed = execFileSync(outfile, ["--version"], {
				encoding: "utf8",
			}).trim();
			expect(printed).toBe(expected);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 60_000);
});

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
