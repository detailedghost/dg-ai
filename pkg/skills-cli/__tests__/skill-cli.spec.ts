import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "./git-repo-fixtures";
import { CLI_ENTRY, runCli } from "./module-call";

const created: string[] = [];
afterAll(() => {
	for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

function home(): string {
	const dir = makeTempDir("dg-skill-cli-");
	created.push(dir);
	return dir;
}

function skillDir(root: string, name: string, files: Record<string, string>): string {
	const dir = join(root, name);
	for (const [rel, content] of Object.entries(files)) {
		mkdirSync(join(dir, rel, ".."), { recursive: true });
		writeFileSync(join(dir, rel), content);
	}
	return dir;
}

function skill(args: string[], root: string) {
	return runCli([process.execPath, "run", CLI_ENTRY, "skill"], args, {
		cwd: root,
		env: { ...process.env, HOME: root, AI_STATE_DIR: join(root, "state") } as Record<string, string>,
	});
}

describe("dg-skills skill", () => {
	test("--help documents audit and split", async () => {
		const root = home();
		const run = await skill(["--help"], root);
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toContain("skill audit");
		expect(run.stdout).toContain("skill split --apply");
	});

	test("an unknown subcommand prints usage and exits 2", async () => {
		const run = await skill(["nope"], home());
		expect(run.exitCode).toBe(2);
		expect(run.stderr).toContain("Usage: skill");
	});

	test("audit exits 0 for a clean skill and 1 when an issue remains", async () => {
		const root = home();
		const clean = skillDir(root, "clean", { "SKILL.md": "# clean\n" });
		const junky = skillDir(root, "junky", { "SKILL.md": "# junky\n", ".DS_Store": "x" });
		expect((await skill(["audit", clean], root)).exitCode).toBe(0);
		const run = await skill(["audit", junky, "--json"], root);
		expect(run.exitCode).toBe(1);
		const report = JSON.parse(run.stdout) as { threshold: number; results: { issues: string[] }[] };
		expect(report.threshold).toBe(1500);
		expect(report.results[0]?.issues).toEqual(["junk file: .DS_Store"]);
	});

	test("audit --fix deletes junk and exits 0", async () => {
		const root = home();
		const junky = skillDir(root, "junky", { "SKILL.md": "# junky\n", ".DS_Store": "x" });
		const run = await skill(["audit", junky, "--fix"], root);
		expect(run.exitCode).toBe(0);
		expect(existsSync(join(junky, ".DS_Store"))).toBe(false);
	});

	test("audit with no dirs reads every skill under the Claude skills directory", async () => {
		const root = home();
		skillDir(join(root, ".claude", "skills"), "alpha", { "SKILL.md": "# alpha\n" });
		skillDir(join(root, ".claude", "skills"), "beta", { "SKILL.md": "# beta\n" });
		const run = await skill(["audit", "--json"], root);
		const report = JSON.parse(run.stdout) as { results: { skill: string }[] };
		expect(report.results.map((r) => r.skill).sort()).toEqual(["alpha", "beta"]);
	});

	test("split --list prints the sections and split --apply backs up under the state root", async () => {
		const root = home();
		const dir = skillDir(root, "big", { "SKILL.md": "# Big\n## Keep\nk\n## Move Me\nm\n" });
		const list = await skill(["split", "--list", dir], root);
		expect(list.exitCode).toBe(0);
		const sections = (JSON.parse(list.stdout) as { sections: { slug: string }[] }).sections;
		expect(sections.map((s) => s.slug)).toEqual(["keep", "move-me"]);

		const manifest = join(root, "manifest.json");
		writeFileSync(
			manifest,
			JSON.stringify({ skillDir: dir, moves: [{ slug: "move-me", dest: "references/move.md" }] }),
		);
		const apply = await skill(["split", "--apply", manifest], root);
		expect(apply.exitCode).toBe(0);
		expect(existsSync(join(dir, "references", "move.md"))).toBe(true);
		const backups = readdirSync(join(root, "state", "skill-cleanup", "backups"));
		expect(backups).toHaveLength(1);
		expect(backups[0]).toStartWith("big-");
	});

	test("split exits 2 on a bad manifest, a missing entry, or no mode", async () => {
		const root = home();
		const manifest = join(root, "manifest.json");
		writeFileSync(manifest, JSON.stringify({ skillDir: root, moves: [] }));
		const bad = await skill(["split", "--apply", manifest], root);
		expect(bad.exitCode).toBe(2);
		expect(bad.stderr).toContain("moves must be a non-empty array");
		expect((await skill(["split", "--list", join(root, "absent")], root)).exitCode).toBe(2);
		expect((await skill(["split"], root)).exitCode).toBe(2);
	});
});
