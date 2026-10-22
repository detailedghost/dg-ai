import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grokTarget } from "../../src/sync/grok";
import type { SyncContext } from "../../src/sync/types";

const tmpDirs: string[] = [];

afterEach(() => {
	for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
	const d = mkdtempSync(join(tmpdir(), prefix));
	tmpDirs.push(d);
	return d;
}

function writeSkill(root: string, name: string, body = "Body.\n"): void {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Test skill ${name}.\n---\n\n${body}`);
}

function makeCtx(overrides: Record<string, string> = {}): { ctx: SyncContext; home: string; cwd: string; pluginRoot: string; localRoot: string } {
	const home = tmp("sync-grok-home-");
	const cwd = tmp("sync-grok-cwd-");
	const pluginRoot = tmp("sync-grok-plugin-");
	const localRoot = join(home, ".claude", "skills");
	return {
		ctx: {
			home,
			cwd,
			env: { ...process.env, DG_SKILLS_DIR: pluginRoot, SKILLS_SRC: localRoot, HOME: home, ...overrides },
		},
		home,
		cwd,
		pluginRoot,
		localRoot,
	};
}

describe("sync grok probe/dry-run", () => {
	test("reports source counts and makes no writes", async () => {
		const { ctx, home } = makeCtx();
		const report = await grokTarget.probe(ctx, {});
		expect(report.ok).toBe(true);
		expect(existsSync(join(home, ".grok", "skills"))).toBe(false);
		expect(report.render()).toContain("skills: 0 merged source(s)");
	});

	test("probe reports claudeCompatSkillsEnabled true by default and the native-compat fact", async () => {
		const { ctx } = makeCtx();
		const report = await grokTarget.probe(ctx, {});
		expect(report.render()).toContain("claudeCompatSkillsEnabled: true");
		expect(report.render()).toContain("natively compatible via Grok's [compat.claude] cells");
	});

	test("probe reports Grok home directory not found when absent, found once it exists", async () => {
		const { ctx, home } = makeCtx();
		const before = await grokTarget.probe(ctx, {});
		expect(before.render()).toContain("Grok home directory not found; using pinned default root and proceeding anyway");

		mkdirSync(join(home, ".grok"), { recursive: true });
		const after = await grokTarget.probe(ctx, {});
		expect(after.render()).toContain("Grok home directory found; using pinned skill root");
	});

	test("dry-run reports planned operations and makes no writes", async () => {
		const { ctx, home } = makeCtx();
		const report = await grokTarget.dryRun(ctx, {});
		expect(report.render()).toMatch(/plan|dry.run|would|operation/i);
		expect(existsSync(join(home, ".grok", "skills"))).toBe(false);
	});

	test("probe reports the project root as not written when .grok is absent at cwd", async () => {
		const { ctx } = makeCtx();
		const report = await grokTarget.probe(ctx, {});
		expect(report.render()).toContain(".grok/skills");
		expect(report.render()).toContain("not written by sync");
	});
});

describe("sync grok apply: compat-aware selection", () => {
	test("default enabled: copies only the plugin-only skill, leaving the local-only one to Grok's native scan", async () => {
		const { ctx, home, pluginRoot, localRoot } = makeCtx();
		writeSkill(pluginRoot, "plugin-only", "Plugin body.\n");
		mkdirSync(localRoot, { recursive: true });
		writeSkill(localRoot, "local-only", "Local body.\n");

		const report = await grokTarget.apply(ctx, {});
		expect(report.ok).toBe(true);

		const grokSkills = join(home, ".grok", "skills");
		expect(existsSync(join(grokSkills, "plugin-only"))).toBe(true);
		expect(existsSync(join(grokSkills, "local-only"))).toBe(false);
	});

	test("GROK_CLAUDE_SKILLS_ENABLED=false: copies both plugin-only and local-only skills", async () => {
		const { ctx, home, pluginRoot, localRoot } = makeCtx({ GROK_CLAUDE_SKILLS_ENABLED: "false" });
		writeSkill(pluginRoot, "plugin-only", "Plugin body.\n");
		mkdirSync(localRoot, { recursive: true });
		writeSkill(localRoot, "local-only", "Local body.\n");

		const report = await grokTarget.apply(ctx, {});
		expect(report.ok).toBe(true);

		const grokSkills = join(home, ".grok", "skills");
		expect(existsSync(join(grokSkills, "plugin-only"))).toBe(true);
		expect(existsSync(join(grokSkills, "local-only"))).toBe(true);
	});

	test("compat enabled: a shadowed name is warned and the plugin content wins in the copy", async () => {
		const { ctx, home, pluginRoot, localRoot } = makeCtx();
		mkdirSync(localRoot, { recursive: true });
		writeSkill(pluginRoot, "shared", "Plugin body.\n");
		writeSkill(localRoot, "shared", "Local body.\n");

		const report = await grokTarget.apply(ctx, {});
		expect(report.render()).toContain("plugin skill 'shared' shadows a local copy");

		const copied = readFileSync(join(home, ".grok", "skills", "shared", "SKILL.md"), "utf8");
		expect(copied).toContain("Plugin body.");
		const localContent = readFileSync(join(localRoot, "shared", "SKILL.md"), "utf8");
		expect(localContent).toContain("Local body.");
	});
});

describe("sync grok apply", () => {
	test("copies a seeded skill's files into the user root with scratch-path rewrites", async () => {
		const { ctx, home, pluginRoot } = makeCtx({ AI_SCRATCH_DIR: "/tmp/dg-grok-scratch" });
		writeSkill(pluginRoot, "demo", "Write output to `/tmp/claude/scratch`.\n");

		const report = await grokTarget.apply(ctx, {});
		expect(report.ok).toBe(true);

		const copied = readFileSync(join(home, ".grok", "skills", "demo", "SKILL.md"), "utf8");
		expect(copied).toContain("/tmp/dg-grok-scratch/scratch");
		expect(copied).not.toContain("/tmp/claude");
	});

	test("project root is untouched when .grok does not exist at cwd", async () => {
		const { ctx, cwd, pluginRoot } = makeCtx();
		writeSkill(pluginRoot, "demo", "Body.\n");
		await grokTarget.apply(ctx, {});
		expect(existsSync(join(cwd, ".grok"))).toBe(false);
	});

	test("project root is populated when .grok already exists at cwd", async () => {
		const { ctx, cwd, pluginRoot } = makeCtx();
		mkdirSync(join(cwd, ".grok"), { recursive: true });
		writeSkill(pluginRoot, "demo", "Body.\n");

		const report = await grokTarget.apply(ctx, {});
		expect(report.ok).toBe(true);
		expect(existsSync(join(cwd, ".grok", "skills", "demo", "SKILL.md"))).toBe(true);
	});

	test("bounded pruning: removing a skill from sources prunes its destination, but never touches an unrelated directory", async () => {
		const { ctx, home, pluginRoot } = makeCtx();
		writeSkill(pluginRoot, "temp-skill", "Body.\n");
		await grokTarget.apply(ctx, {});
		const grokSkills = join(home, ".grok", "skills");
		expect(existsSync(join(grokSkills, "temp-skill"))).toBe(true);

		mkdirSync(join(grokSkills, "hand-placed"), { recursive: true });
		writeFileSync(join(grokSkills, "hand-placed", "notes.md"), "not ours\n");

		rmSync(join(pluginRoot, "temp-skill"), { recursive: true, force: true });
		const second = await grokTarget.apply(ctx, {});

		expect(existsSync(join(grokSkills, "temp-skill"))).toBe(false);
		expect(second.render()).toContain("pruned stale skill from user root: temp-skill");
		expect(existsSync(join(grokSkills, "hand-placed", "notes.md"))).toBe(true);
	});

	test("verify passes after a clean apply and fails when a synced directory goes missing", async () => {
		const { ctx, home, pluginRoot } = makeCtx();
		writeSkill(pluginRoot, "checked", "Body.\n");
		await grokTarget.apply(ctx, {});

		const clean = await grokTarget.verify(ctx, {});
		expect(clean.ok).toBe(true);
		expect(clean.render()).toContain("Verification OK");

		rmSync(join(home, ".grok", "skills", "checked"), { recursive: true, force: true });
		const broken = await grokTarget.verify(ctx, {});
		expect(broken.ok).toBe(false);
	});
});

describe("sync grok compat-cell resolution", () => {
	test("GROK_CLAUDE_SKILLS_ENABLED=false wins over a config.toml that says true", async () => {
		const { ctx, home } = makeCtx({ GROK_CLAUDE_SKILLS_ENABLED: "false" });
		mkdirSync(join(home, ".grok"), { recursive: true });
		writeFileSync(join(home, ".grok", "config.toml"), "[compat.claude]\nskills = true\n");

		const report = await grokTarget.probe(ctx, {});
		expect(report.render()).toContain("claudeCompatSkillsEnabled: false");
	});

	test("config.toml [compat.claude] skills = false disables it when no env var is set", async () => {
		const { ctx, home } = makeCtx();
		mkdirSync(join(home, ".grok"), { recursive: true });
		writeFileSync(join(home, ".grok", "config.toml"), "[compat.claude]\nrules = true\nskills = false\nagents = true\n");

		const report = await grokTarget.probe(ctx, {});
		expect(report.render()).toContain("claudeCompatSkillsEnabled: false");
	});

	test("no config.toml at all defaults to enabled", async () => {
		const { ctx } = makeCtx();
		const report = await grokTarget.probe(ctx, {});
		expect(report.render()).toContain("claudeCompatSkillsEnabled: true");
	});

	test("a [compat.claude] section for a different vendor's section header below it doesn't leak", async () => {
		const { ctx, home } = makeCtx();
		mkdirSync(join(home, ".grok"), { recursive: true });
		writeFileSync(join(home, ".grok", "config.toml"), "[compat.claude]\nrules = true\n\n[compat.cursor]\nskills = false\n");

		const report = await grokTarget.probe(ctx, {});
		expect(report.render()).toContain("claudeCompatSkillsEnabled: true");
	});
});

describe("sync grok flag parsing", () => {
	test("accepts no flags and rejects any argument", () => {
		expect(grokTarget.parseFlags([])).toEqual({ flags: {} });
		expect(grokTarget.parseFlags(["--bogus"]).error).toBeTruthy();
	});
});
