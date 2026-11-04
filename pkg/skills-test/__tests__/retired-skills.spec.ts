import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { RETIRED_SKILL_HASHES, RETIRED_SKILLS } from "../../common/src/node/install-skills";
import { runSkillsOnlyInstall } from "../../skills-cli/src/install/skills-only";
import { REPO_ROOT, makeTempDir, readRepoFile, removeTempDirs } from "./test-support";

const RETIRED = ["teach", "wait-what"];
const SKILLS = join(REPO_ROOT, "plugins", "dg", "skills");
const DG_COPIES = join(import.meta.dir, "fixtures", "retired-skills");
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

afterEach(removeTempDirs);

function retiredLine(script: string, opener: RegExp): string {
	return script.split("\n").find((line) => opener.test(line)) ?? "";
}

describe("retired dg skills teach and wait-what", () => {
	test("plugins/dg/skills holds neither directory", () => {
		const names = readdirSync(SKILLS);
		for (const name of RETIRED) expect(names).not.toContain(name);
	});

	test("RETIRED_SKILLS lists both next to phone-friend", () => {
		for (const name of [...RETIRED, "phone-friend"]) expect(RETIRED_SKILLS).toContain(name);
	});

	test("a skills-only install removes dg's old copies, keeps other copies with the same names, and keeps unrelated entries", () => {
		const root = makeTempDir("retired-skills-");
		const repo = join(root, "repo");
		const source = join(repo, "plugins", "dg", "skills");
		const dest = join(root, "dest");
		mkdirSync(join(source, "address"), { recursive: true });
		writeFileSync(join(source, "address", "SKILL.md"), "---\nname: address\n---\n");
		mkdirSync(join(dest, "teach", "references"), { recursive: true });
		copyFileSync(join(DG_COPIES, "teach", "SKILL.md"), join(dest, "teach", "SKILL.md"));
		writeFileSync(join(dest, "teach", "references", "old.md"), "old");
		mkdirSync(join(dest, "wait-what"), { recursive: true });
		writeFileSync(join(dest, "wait-what", "SKILL.md"), "---\nname: wait-what\ndescription: upstream copy\n---\n");
		mkdirSync(join(dest, "mine"), { recursive: true });
		writeFileSync(join(dest, "mine", "SKILL.md"), "mine");

		const result = runSkillsOnlyInstall({ repo, dest, repoRoot: repo });

		expect(result.dest).toBe(dest);

		expect(existsSync(join(dest, "teach"))).toBe(false);
		expect(existsSync(join(dest, "wait-what", "SKILL.md"))).toBe(true);
		expect(existsSync(join(dest, "address", "SKILL.md"))).toBe(true);
		expect(existsSync(join(dest, "mine", "SKILL.md"))).toBe(true);
	});

	test("a dg copy of each retired skill matches a known hash, and the bootstraps carry every hash", () => {
		const sh = readRepoFile("pkg", "skills-cli", "bootstrap.sh");
		const ps1 = readRepoFile("pkg", "skills-cli", "bootstrap.ps1");
		for (const name of RETIRED) {
			expect(RETIRED_SKILL_HASHES[name]).toContain(sha256(join(DG_COPIES, name, "SKILL.md")));
			for (const hash of RETIRED_SKILL_HASHES[name] ?? []) {
				expect(sh).toContain(hash);
				expect(ps1).toContain(hash);
			}
		}
	});

	test("a CRLF copy of each retired fixture matches a known hash", () => {
		for (const name of RETIRED) {
			const lf = readFileSync(join(DG_COPIES, name, "SKILL.md"), "utf8");
			const crlf = createHash("sha256").update(lf.replace(/\n/g, "\r\n")).digest("hex");
			expect(RETIRED_SKILL_HASHES[name]).toContain(crlf);
		}
	});

	test("a retired directory with no SKILL.md is kept", () => {
		const root = makeTempDir("retired-skills-");
		const repo = join(root, "repo");
		const source = join(repo, "plugins", "dg", "skills");
		const dest = join(root, "dest");
		mkdirSync(join(source, "address"), { recursive: true });
		writeFileSync(join(source, "address", "SKILL.md"), "---\nname: address\n---\n");
		mkdirSync(join(dest, "teach"), { recursive: true });
		writeFileSync(join(dest, "teach", "notes.md"), "mine");

		runSkillsOnlyInstall({ repo, dest, repoRoot: repo });

		expect(existsSync(join(dest, "teach", "notes.md"))).toBe(true);
	});

	test("bootstrap.sh names both in its retired loop", () => {
		const line = retiredLine(readRepoFile("pkg", "skills-cli", "bootstrap.sh"), /for retired in /);
		expect(line).not.toBe("");
		for (const name of [...RETIRED, "phone-friend"]) expect(line).toMatch(new RegExp(`(^|[\\s])${name}([\\s;]|$)`));
	});

	test("bootstrap.ps1 names both in its retired loop", () => {
		const line = retiredLine(readRepoFile("pkg", "skills-cli", "bootstrap.ps1"), /foreach \(\$retired in /);
		expect(line).not.toBe("");
		for (const name of [...RETIRED, "phone-friend"]) expect(line).toContain(`"${name}"`);
	});

	test("the hand-listed installed skill files carry no entry for either skill", async () => {
		const { INSTALLED_SKILL_FILES } = await import("../../common/__tests__/installed-skill-files");
		for (const name of RETIRED) {
			expect(INSTALLED_SKILL_FILES.filter((file) => file.startsWith(`${name}/`))).toEqual([]);
		}
	});
});
