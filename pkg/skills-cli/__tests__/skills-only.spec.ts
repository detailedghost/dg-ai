import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertSkillsOnlyFlags,
	runSkillsOnlyInstall,
	skillsOnlyReport,
} from "../src/commands/skills-only";

const SUMMARY =
	"Skills-only install: no binaries were fetched and no skill content was executed.";

describe("skills-only helpers", () => {
	test("rejects flags that would fetch binaries or build the extension", () => {
		expect(() =>
			assertSkillsOnlyFlags({ cliOnly: false, local: false, target: undefined }),
		).not.toThrow();
		expect(() =>
			assertSkillsOnlyFlags({ cliOnly: true, local: false, target: undefined }),
		).toThrow(/accepts only --repo and --dest/);
		expect(() =>
			assertSkillsOnlyFlags({ cliOnly: false, local: true, target: undefined }),
		).toThrow(/accepts only --repo and --dest/);
		expect(() =>
			assertSkillsOnlyFlags({ cliOnly: false, local: false, target: "firefox" }),
		).toThrow(/accepts only --repo and --dest/);
	});

	test("uses the requested checkout and destination", () => {
		const directory = mkdtempSync(join(tmpdir(), "dg-skills-only-fn-"));
		const repo = join(directory, "repo");
		const other = join(directory, "other");
		const dest = join(directory, "out");
		try {
			mkdirSync(join(repo, "plugins", "dg", "skills", "from-repo"), { recursive: true });
			mkdirSync(join(other, "plugins", "dg", "skills", "from-root"), { recursive: true });
			writeFileSync(join(repo, "plugins", "dg", "skills", "from-repo", "SKILL.md"), "repo\n");
			writeFileSync(join(other, "plugins", "dg", "skills", "from-root", "SKILL.md"), "root\n");
			const result = runSkillsOnlyInstall({
				repo,
				dest: "",
				repoRoot: other,
				env: { DG_SKILLS_DEST: dest },
				home: directory,
			});
			expect(result.dest).toBe(dest);
			expect(result.files).toEqual(["from-repo/SKILL.md"]);
			expect(readFileSync(join(dest, "from-repo", "SKILL.md"), "utf8")).toBe("repo\n");
			const fromRoot = runSkillsOnlyInstall({
				repo: undefined,
				dest,
				repoRoot: other,
				env: {},
				home: directory,
			});
			expect(fromRoot.files).toEqual(["from-root/SKILL.md"]);
			const fallback = runSkillsOnlyInstall({
				repo,
				dest: undefined,
				repoRoot: other,
				env: {},
				home: directory,
			});
			expect(fallback.dest).toBe(join(directory, ".dg", "skills"));
			expect(fallback.files).toEqual(["from-repo/SKILL.md"]);
			expect(() =>
				runSkillsOnlyInstall({
					repo: join(directory, "missing"),
					dest,
					repoRoot: other,
				}),
			).toThrow(/no skill instruction files at/);
			expect(skillsOnlyReport(result)).toBe(
				`from-repo/SKILL.md\nInstalled 1 skill files at ${dest}.\n${SUMMARY}`,
			);
			mkdirSync(join(repo, "plugins", "dg", "agents"), { recursive: true });
			writeFileSync(join(repo, "plugins", "dg", "agents", "thrash.md"), "thrash persona\n");
			const withPersona = runSkillsOnlyInstall({
				repo,
				dest,
				repoRoot: other,
				env: {},
				home: directory,
			});
			const persona = join(directory, "agents", "thrash.md");
			expect(withPersona.persona).toBe(persona);
			expect(readFileSync(persona, "utf8")).toBe("thrash persona\n");
			expect(skillsOnlyReport(withPersona)).toContain(
				`Installed thrash persona at ${persona}.`,
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
