import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeTarget } from "../../src/sync/claude";
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

function makeCtx(): { ctx: SyncContext; home: string; pluginRoot: string; localRoot: string } {
	const home = tmp("sync-claude-home-");
	const pluginRoot = tmp("sync-claude-plugin-");
	const localRoot = join(home, ".claude", "skills");
	return {
		ctx: { home, cwd: home, env: { ...process.env, DG_SKILLS_DIR: pluginRoot, SKILLS_SRC: localRoot, HOME: home } },
		home,
		pluginRoot,
		localRoot,
	};
}

function snapshotFiles(root: string): string[] {
	if (!existsSync(root)) return [];
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir)) {
			const full = join(dir, name);
			if (statSync(full).isDirectory()) walk(full);
			else out.push(full);
		}
	};
	walk(root);
	return out.sort();
}

describe("sync claude: probe/verify are read-only diagnostics", () => {
	test("probe and verify report the merge and never write anything", async () => {
		const { ctx, home, pluginRoot } = makeCtx();
		writeSkill(pluginRoot, "demo", "Body.\n");
		const before = snapshotFiles(home);

		for (const verb of ["probe", "verify"] as const) {
			const report = await claudeTarget[verb](ctx, {});
			expect(report.ok).toBe(true);
			expect(report.render()).toContain("skills: 1 merged source(s)");
			expect(report.render()).toContain(
				"Claude Code loads the dg plugin's skills and agents directly; no destination-side sync is needed or performed for this target.",
			);
		}
		expect(snapshotFiles(home)).toEqual(before);
	});

	test("reports a shadowed skill name with the standard warning phrasing and leaves the local source byte-identical", async () => {
		const { ctx, pluginRoot, localRoot } = makeCtx();
		mkdirSync(localRoot, { recursive: true });
		writeSkill(pluginRoot, "shared", "Plugin body.\n");
		writeSkill(localRoot, "shared", "Local body.\n");
		const before = readFileSync(join(localRoot, "shared", "SKILL.md"), "utf8");

		for (const verb of ["probe", "verify"] as const) {
			const report = await claudeTarget[verb](ctx, {});
			expect(report.render()).toContain("plugin skill 'shared' shadows a local copy under the Claude skills directory");
		}

		expect(readFileSync(join(localRoot, "shared", "SKILL.md"), "utf8")).toBe(before);
	});

	test("verify fails only when neither the plugin tree nor the local Claude skills directory resolves to anything", async () => {
		const home = tmp("sync-claude-empty-home-");
		const ctx: SyncContext = {
			home,
			cwd: home,
			env: { ...process.env, DG_SKILLS_DIR: join(home, "no-such-plugin-root"), SKILLS_SRC: join(home, "no-such-local-root"), HOME: home },
		};
		const report = await claudeTarget.verify(ctx, {});
		expect(report.ok).toBe(false);
		expect(report.render()).toContain("no skill sources found: checked the dg plugin tree and the Claude skills directory");
	});
});

describe("sync claude: apply and dry-run refuse", () => {
	for (const verb of ["apply", "dryRun"] as const) {
		test(`${verb} returns ok:false naming another target, and writes nothing`, async () => {
			const { ctx, home, pluginRoot } = makeCtx();
			writeSkill(pluginRoot, "demo", "Body.\n");
			const before = snapshotFiles(home);

			const report = await claudeTarget[verb](ctx, {});
			expect(report.ok).toBe(false);
			expect(report.render()).toMatch(/copilot|opencode|codex|pi|grok/);
			expect(report.render()).toContain("not a destination");

			expect(snapshotFiles(home)).toEqual(before);
		});
	}
});

describe("sync claude flag parsing", () => {
	test("accepts no flags and rejects any argument", () => {
		expect(claudeTarget.parseFlags([])).toEqual({ flags: {} });
		expect(claudeTarget.parseFlags(["--bogus"]).error).toBeTruthy();
	});
});
