import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSkillsCli } from "../build";

describe("buildSkillsCli", () => {
	test("--version reports a sha1 of the entry file, so a stale compiled binary is diagnosable", async () => {
		const dir = mkdtempSync(join(tmpdir(), "dg-skills-build-"));
		const outfile = join(dir, "dg-skills-test");
		try {
			await buildSkillsCli({ outfile });
			const entrypoint = join(import.meta.dir, "..", "src", "index.ts");
			const expected = createHash("sha1")
				.update(readFileSync(entrypoint))
				.digest("hex");
			const printed = execFileSync(outfile, ["--version"], {
				encoding: "utf8",
			}).trim();
			expect(printed).toBe(expected);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 60_000);
});
