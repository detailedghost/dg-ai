import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir, REPO_ROOT, removeTempDirs } from "./test-support";

const SCRIPT = join(REPO_ROOT, "scripts", "skill-bootstrap-block.ts");
const SKILLS_DIR = join(REPO_ROOT, "plugins", "dg", "skills");

afterAll(removeTempDirs);

function check(root?: string): { code: number; out: string } {
	const run = Bun.spawnSync([process.execPath, SCRIPT, "--check", ...(root ? ["--root", root] : [])], {
		stdout: "pipe",
		stderr: "pipe",
	});
	return { code: run.exitCode ?? -1, out: `${run.stdout}${run.stderr}` };
}

function filesUnder(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const path = join(dir, entry);
		return statSync(path).isDirectory() ? filesUnder(path) : [path];
	});
}

describe("skill-bootstrap-block --check", () => {
	test("passes on the committed skills", () => {
		const result = check();
		expect(result.out).toBe("");
		expect(result.code).toBe(0);
	});

	test("tells the agent to use the launcher path whenever the bare name does not answer", () => {
		const text = readFileSync(join(SKILLS_DIR, "worktree", "SKILL.md"), "utf8");
		expect(text).toContain(
			"Call `dg-skills` in every later step. If `dg-skills` alone does not answer, also after the bootstrap, call `${DG_HOME:-$HOME/.local}/bin/dg-skills` instead.",
		);
	});

	test("fails once one SKILL.md first-run block is edited by hand", () => {
		const copy = makeTempDir("dg-skill-block-");
		cpSync(SKILLS_DIR, copy, { recursive: true });
		const skill = join(copy, "worktree", "SKILL.md");
		const text = readFileSync(skill, "utf8");
		writeFileSync(skill, text.replace(/^ {2}"\$\{DG_HOME:-\$HOME\/\.local\}\/bin\/dg-skills".*\n/m, ""));

		const result = check(copy);

		expect(result.code).toBe(1);
		expect(result.out).toContain("worktree/SKILL.md");
	});

	test("fails when a skill calls the CLI through the old ~/.dg/bin path", () => {
		const copy = makeTempDir("dg-skill-block-");
		cpSync(SKILLS_DIR, copy, { recursive: true });
		const reference = join(copy, "jot", "SKILL.md");
		writeFileSync(reference, `${readFileSync(reference, "utf8")}\nRun ~/.dg/bin/dg-skills jot list.\n`);

		expect(check(copy).code).toBe(1);
	});
});

describe("packaged skills call the bare launcher", () => {
	test("no file under plugins/dg/skills names ~/.dg/bin/", () => {
		const hits = filesUnder(SKILLS_DIR).filter((path) => readFileSync(path, "utf8").includes("~/.dg/bin/"));
		expect(hits).toEqual([]);
	});

	test("every first-run block falls back to the launcher path and says which command to call", () => {
		const skills = readdirSync(SKILLS_DIR)
			.map((name) => join(SKILLS_DIR, name, "SKILL.md"))
			.filter((path) => {
				try {
					return /bootstrap\.sh \| sh/.test(readFileSync(path, "utf8"));
				} catch {
					return false;
				}
			});
		expect(skills.length).toBeGreaterThan(40);
		for (const path of skills) {
			const text = readFileSync(path, "utf8");
			expect([path, /^ *(?:\{ )?"\$\{DG_HOME:-\$HOME\/\.local\}\/bin\/dg-[a-z]+"/m.test(text)]).toEqual([path, true]);
			expect([path, /Call `dg-[a-z]+`(?: and `dg-[a-z]+`)* in every later step\./.test(text)]).toEqual([path, true]);
		}
	});
});

describe("first-run blocks after the bootstrap", () => {
	test("call the launcher by its path, so a launcher folder missing from PATH still works", () => {
		const hits: string[] = [];
		for (const path of filesUnder(SKILLS_DIR).filter((file) => file.endsWith(".md"))) {
			const text = readFileSync(path, "utf8");
			for (const fence of text.matchAll(/^( *)```(?:bash|sh)\n([\s\S]*?)^\1```/gm)) {
				const lines = (fence[2] ?? "").split("\n");
				const at = lines.findIndex((line) => /bootstrap\.sh \| sh/.test(line));
				if (at < 0) continue;
				for (const line of lines.slice(at + 1))
					if (/^\s*dg-(skills|agent|daemon)\b/.test(line)) hits.push(`${path}: ${line.trim()}`);
			}
		}
		expect(hits).toEqual([]);
	});

	test("probe the DG_HOME launcher folder before the default one", () => {
		const text = readFileSync(join(SKILLS_DIR, "catchup", "SKILL.md"), "utf8");
		expect(text).toContain('  "${DG_HOME:-$HOME/.local}/bin/dg-skills" catchup --help >/dev/null 2>&1 ||\n');
		expect(text).toContain('\n"${DG_HOME:-$HOME/.local}/bin/dg-skills" catchup\n');
	});
});
