import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertSkillsOnlyFlags,
	runSkillsOnlyInstall,
	skillsOnlyReport,
} from "../src/commands/skills-only";

const PERSONAS = [
	"checkpoint",
	"copilot-antagonist",
	"csharp",
	"dba",
	"devops",
	"foreman",
	"js",
	"lore",
	"python",
	"qa-devops",
	"qa-perf",
	"qa-writer",
	"reviewer",
	"security",
	"shell",
	"thrash",
	"wave",
].map((name) => `${name}.md`);

const SUMMARY =
	"Skills-only install: no skill content was executed. Fetching only the dg-skills CLI (no daemon, agent or extension).";

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
			const agents = join(repo, "plugins", "dg", "agents");
			mkdirSync(agents, { recursive: true });
			for (const name of PERSONAS) writeFileSync(join(agents, name), `${name} persona\n`);
			const withPersonas = runSkillsOnlyInstall({
				repo,
				dest,
				repoRoot: other,
				env: {},
				home: directory,
			});
			const installed = join(directory, "agents");
			expect(withPersonas.personas).toEqual(PERSONAS);
			expect(readdirSync(installed).sort()).toEqual(PERSONAS);
			for (const name of PERSONAS) {
				expect(readFileSync(join(installed, name), "utf8")).toBe(`${name} persona\n`);
			}
			expect(skillsOnlyReport(withPersonas)).toContain(
				`Installed ${PERSONAS.length} personas at ${installed}.`,
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("refuses a persona symlink before writing any skill file", () => {
		const directory = mkdtempSync(join(tmpdir(), "dg-skills-only-link-"));
		const repo = join(directory, "repo");
		const dest = join(directory, "out", "skills");
		try {
			mkdirSync(join(repo, "plugins", "dg", "skills", "one"), { recursive: true });
			writeFileSync(join(repo, "plugins", "dg", "skills", "one", "SKILL.md"), "one\n");
			mkdirSync(join(repo, "plugins", "dg", "agents"), { recursive: true });
			writeFileSync(join(directory, "target.md"), "target\n");
			symlinkSync(join(directory, "target.md"), join(repo, "plugins", "dg", "agents", "bad.md"));
			expect(() =>
				runSkillsOnlyInstall({ repo, dest, repoRoot: repo, env: {}, home: directory }),
			).toThrow(/refuses symlink plugins\/dg\/agents\/bad.md/);
			expect(existsSync(dest)).toBe(false);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("replaces a symlink at a persona destination without writing through it", () => {
		const directory = mkdtempSync(join(tmpdir(), "dg-skills-only-dest-link-"));
		const repo = join(directory, "repo");
		const dest = join(directory, "out", "skills");
		const target = join(directory, "outside.md");
		try {
			mkdirSync(join(repo, "plugins", "dg", "skills", "one"), { recursive: true });
			writeFileSync(join(repo, "plugins", "dg", "skills", "one", "SKILL.md"), "one\n");
			mkdirSync(join(repo, "plugins", "dg", "agents"), { recursive: true });
			writeFileSync(join(repo, "plugins", "dg", "agents", "thrash.md"), "thrash\n");
			mkdirSync(join(directory, "out", "agents"), { recursive: true });
			writeFileSync(target, "outside\n");
			symlinkSync(target, join(directory, "out", "agents", "thrash.md"));
			runSkillsOnlyInstall({ repo, dest, repoRoot: repo, env: {}, home: directory });
			expect(readFileSync(target, "utf8")).toBe("outside\n");
			expect(readFileSync(join(directory, "out", "agents", "thrash.md"), "utf8")).toBe("thrash\n");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
