import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piTarget } from "../../src/sync/pi";
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

function makeCtx(overrides: Record<string, string> = {}): { ctx: SyncContext; home: string; cwd: string; pluginRoot: string } {
	const home = tmp("sync-pi-home-");
	const cwd = tmp("sync-pi-cwd-");
	const pluginRoot = tmp("sync-pi-plugin-");
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
	};
}

describe("sync pi probe/dry-run", () => {
	test("reports source counts and makes no writes", async () => {
		const { ctx, home } = makeCtx();
		const before = existsSync(join(home, ".pi"));
		const report = await piTarget.probe(ctx, {});
		expect(report.ok).toBe(true);
		expect(existsSync(join(home, ".pi"))).toBe(before);
		expect(report.render()).toContain("skills: 0 source(s)");
	});

	test("probe includes the fixed unsupported-capabilities line", async () => {
		const { ctx } = makeCtx();
		const report = await piTarget.probe(ctx, {});
		expect(report.render()).toContain("unsupported: agents, hooks, mcp, statusline (skills only)");
	});

	test("probe reports Pi agent directory not found when absent, found once it exists", async () => {
		const { ctx, home } = makeCtx();
		const before = await piTarget.probe(ctx, {});
		expect(before.render()).toContain("Pi agent directory not found; using pinned default root and proceeding anyway");

		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		const after = await piTarget.probe(ctx, {});
		expect(after.render()).toContain("Pi agent directory found; using pinned skill root");
	});

	test("dry-run reports planned operations and makes no writes", async () => {
		const { ctx, home } = makeCtx();
		const report = await piTarget.dryRun(ctx, {});
		expect(report.render()).toMatch(/plan|dry.run|would|operation/i);
		expect(existsSync(join(home, ".pi", "agent", "skills"))).toBe(false);
	});

	test("probe reports the project root as not written when .pi is absent at cwd", async () => {
		const { ctx } = makeCtx();
		const report = await piTarget.probe(ctx, {});
		expect(report.render()).toContain(".pi/skills");
		expect(report.render()).toContain("not written by sync");
	});
});

describe("sync pi apply", () => {
	test("copies a seeded skill's files into the user root with scratch-path rewrites", async () => {
		const { ctx, home, pluginRoot } = makeCtx({ AI_SCRATCH_DIR: "/tmp/dg-pi-scratch" });
		writeSkill(pluginRoot, "demo", "Write output to `/tmp/claude/scratch`.\n");

		const report = await piTarget.apply(ctx, {});
		expect(report.ok).toBe(true);

		const copied = readFileSync(join(home, ".pi", "agent", "skills", "demo", "SKILL.md"), "utf8");
		expect(copied).toContain("/tmp/dg-pi-scratch/scratch");
		expect(copied).not.toContain("/tmp/claude");
		expect(copied).toMatch(/^---\n/);
	});

	test("project root is untouched when .pi does not exist at cwd", async () => {
		const { ctx, cwd, pluginRoot } = makeCtx();
		writeSkill(pluginRoot, "demo", "Body.\n");
		await piTarget.apply(ctx, {});
		expect(existsSync(join(cwd, ".pi"))).toBe(false);
	});

	test("project root is populated when .pi already exists at cwd", async () => {
		const { ctx, cwd, pluginRoot } = makeCtx();
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeSkill(pluginRoot, "demo", "Body.\n");

		const report = await piTarget.apply(ctx, {});
		expect(report.ok).toBe(true);
		expect(existsSync(join(cwd, ".pi", "skills", "demo", "SKILL.md"))).toBe(true);
	});

	test("plugin wins a duplicate name; local source is left untouched on disk", async () => {
		const { ctx, home, pluginRoot } = makeCtx();
		const localRoot = join(home, ".claude", "skills");
		mkdirSync(localRoot, { recursive: true });
		writeSkill(pluginRoot, "shared", "Plugin body.\n");
		writeSkill(localRoot, "shared", "Local body.\n");

		const report = await piTarget.apply(ctx, {});
		expect(report.render()).toContain("plugin skill 'shared' shadows a local copy");

		const copied = readFileSync(join(home, ".pi", "agent", "skills", "shared", "SKILL.md"), "utf8");
		expect(copied).toContain("Plugin body.");
		const localContent = readFileSync(join(localRoot, "shared", "SKILL.md"), "utf8");
		expect(localContent).toContain("Local body.");
	});

	test("bounded pruning: removing a skill from sources prunes its destination, but never touches an unrelated directory", async () => {
		const { ctx, home, pluginRoot } = makeCtx();
		writeSkill(pluginRoot, "temp-skill", "Body.\n");
		await piTarget.apply(ctx, {});
		const piSkills = join(home, ".pi", "agent", "skills");
		expect(existsSync(join(piSkills, "temp-skill"))).toBe(true);

		mkdirSync(join(piSkills, "hand-placed"), { recursive: true });
		writeFileSync(join(piSkills, "hand-placed", "notes.md"), "not ours\n");

		rmSync(join(pluginRoot, "temp-skill"), { recursive: true, force: true });
		const second = await piTarget.apply(ctx, {});

		expect(existsSync(join(piSkills, "temp-skill"))).toBe(false);
		expect(second.render()).toContain("pruned stale skill from user root: temp-skill");
		expect(existsSync(join(piSkills, "hand-placed", "notes.md"))).toBe(true);
	});

	test("verify passes after a clean apply and fails when a synced directory goes missing", async () => {
		const { ctx, home, pluginRoot } = makeCtx();
		writeSkill(pluginRoot, "checked", "Body.\n");
		await piTarget.apply(ctx, {});

		const clean = await piTarget.verify(ctx, {});
		expect(clean.ok).toBe(true);
		expect(clean.render()).toContain("Verification OK");

		rmSync(join(home, ".pi", "agent", "skills", "checked"), { recursive: true, force: true });
		const broken = await piTarget.verify(ctx, {});
		expect(broken.ok).toBe(false);
	});
});

describe("sync pi flag parsing", () => {
	test("accepts no flags and rejects any argument", () => {
		expect(piTarget.parseFlags([])).toEqual({ flags: {} });
		expect(piTarget.parseFlags(["--bogus"]).error).toBeTruthy();
	});
});
