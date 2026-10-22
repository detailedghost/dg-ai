import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexTarget } from "../../src/sync/codex";
import type { SyncContext } from "../../src/sync/types";

const STATUS_LINE =
	'status_line = ["current-dir", "model-with-reasoning", "context-remaining", "five-hour-limit", "weekly-limit"]';
const TERMINAL_TITLE = 'terminal_title = ["spinner", "project", "model"]';

interface HookEntryJson {
	type: string;
	command: string;
}
interface HookGroupJson {
	matcher: string;
	hooks: HookEntryJson[];
}
interface HooksJson {
	hooks: { PreToolUse: HookGroupJson[]; PostToolUse: HookGroupJson[] };
}

const tmpDirs: string[] = [];

afterEach(() => {
	for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
}

function writeHookScript(path: string): void {
	writeFileSync(path, "#!/usr/bin/env bash\nexit 0\n");
	chmodSync(path, 0o755);
}

function writePluginCodexSyncSkill(pluginSkills: string): void {
	mkdirSync(join(pluginSkills, "codex-sync"), { recursive: true });
	writeFileSync(
		join(pluginSkills, "codex-sync", "SKILL.md"),
		["---", "name: codex-sync", "description: Codex-native sync skill.", "---", "", "Run dg-skills sync codex <mode>.", ""].join(
			"\n",
		),
	);
}

interface Fixture {
	ctx: SyncContext;
	home: string;
	claudeHome: string;
	claudeSkills: string;
	claudeAgents: string;
	claudeSettings: string;
	codexHome: string;
	config: string;
	hooks: string;
	agentsHome: string;
	pluginSkills: string;
	hooksRoot: string;
	codexSkillsDir: string;
	codexAgentsDir: string;
	demoSkill: string;
	vizSkill: string;
	jsAgent: string;
	qaCodeAgent: string;
	checkpointAgent: string;
}

function buildFixture(opts: { withHooksRoot?: boolean } = {}): Fixture {
	const withHooksRoot = opts.withHooksRoot !== false;
	const home = tmp("sync-codex-home-");
	const claudeHome = join(home, ".claude");
	const claudeSkills = join(claudeHome, "skills");
	const claudeAgents = join(claudeHome, "agents");
	const codexHome = join(home, ".codex");
	const agentsHome = join(home, ".agents");
	const pluginSkills = join(home, "dg-plugin", "skills");
	const hooksRoot = tmp("sync-codex-hooks-");

	mkdirSync(claudeSkills, { recursive: true });
	mkdirSync(claudeAgents, { recursive: true });
	mkdirSync(codexHome, { recursive: true });
	mkdirSync(join(agentsHome, "skills"), { recursive: true });
	mkdirSync(pluginSkills, { recursive: true });
	writePluginCodexSyncSkill(pluginSkills);

	writeFileSync(
		join(claudeAgents, "js.md"),
		[
			"---",
			"name: js",
			"description: JavaScript and TypeScript development.",
			"model: sonnet",
			"---",
			"",
			"Use /tmp/claude/js scratch only when needed.",
			"",
		].join("\n"),
	);
	writeFileSync(
		join(claudeAgents, "qa-code.md"),
		["---", "name: qa-code", "description: Code quality QA.", "model: opus", "---", "", "Review logic.", ""].join("\n"),
	);
	writeFileSync(
		join(claudeAgents, "checkpoint.md"),
		[
			"---",
			"name: checkpoint",
			"description: Mechanical completion auditor.",
			'model: "haiku"',
			"---",
			"",
			"Report incomplete checklist items.",
			"",
		].join("\n"),
	);

	mkdirSync(join(claudeSkills, "demo"), { recursive: true });
	writeFileSync(
		join(claudeSkills, "demo", "SKILL.md"),
		[
			"---",
			"name: demo",
			"description: Create demo assets.",
			"---",
			"",
			"Write demo output to `/tmp/claude/demo/`.",
			"Run `demo-cli record` when recording.",
			"",
		].join("\n"),
	);
	mkdirSync(join(claudeSkills, "viz"), { recursive: true });
	writeFileSync(
		join(claudeSkills, "viz", "SKILL.md"),
		["# /viz", "", "Render a board payload as a styled HTML page in a local Astro dev server.", ""].join("\n"),
	);

	if (withHooksRoot) {
		writeHookScript(join(hooksRoot, "rtk-codex-hook.sh"));
		writeHookScript(join(hooksRoot, "codex-apply-patch-inputs.sh"));
	}

	const claudeSettings = join(claudeHome, "settings.json");
	writeFileSync(
		claudeSettings,
		JSON.stringify(
			{
				statusLine: { type: "command", command: "bash /home/test/scripts/ai/claude/statusline-command.sh" },
				hooks: {
					PreToolUse: [
						{ matcher: "Bash", hooks: [{ type: "command", command: "rtk hook claude" }] },
						{
							matcher: "Bash",
							hooks: [
								{ type: "command", command: join(hooksRoot, "pr-prose-hook.sh") },
								{ type: "command", command: join(hooksRoot, "pr-confirm-hook.sh") },
							],
						},
					],
					PostToolUse: [
						{ matcher: "Edit|Write|MultiEdit", hooks: [{ type: "command", command: join(hooksRoot, "format-hook.sh") }] },
					],
				},
			},
			null,
			2,
		),
	);

	const config = join(codexHome, "config.toml");
	writeFileSync(
		config,
		[
			'approval_policy = "on-request"',
			'status_line = ["model", "current-dir"]',
			'terminal_title = ["spinner", "project"]',
			"",
			'[projects."/workspace"]',
			'trust_level = "trusted"',
			"",
			"[mcp_servers.fff]",
			'command = "/tmp/fff-mcp"',
			"",
			"[mcp_servers.context7]",
			'command = "npx"',
			'args = ["-y", "@upstash/context7-mcp", "--api-key", "ctx7sk-test-only"]',
			"",
		].join("\n"),
	);

	const hooks = join(codexHome, "hooks.json");
	writeFileSync(
		hooks,
		JSON.stringify({
			hooks: {
				PreToolUse: [
					{ matcher: "Bash", hooks: [{ type: "command", command: "rtk hook claude" }] },
					{ matcher: "Bash", hooks: [{ type: "command", command: join(hooksRoot, "pr-confirm-hook.sh") }] },
				],
				PostToolUse: [
					{ matcher: "Edit|Write|MultiEdit", hooks: [{ type: "command", command: join(hooksRoot, "lint-hook.sh") }] },
				],
			},
		}),
	);

	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env.HOOKS_ROOT;
	env.CODEX_HOME = codexHome;
	env.CLAUDE_HOME = claudeHome;
	env.AGENTS_HOME = agentsHome;
	env.DG_SKILLS_DIR = pluginSkills;
	env.AI_SCRATCH_DIR = "/tmp/ai";
	env.AI_STATE_DIR = join(home, ".local", "state", "ai");
	if (withHooksRoot) env.HOOKS_ROOT = hooksRoot;

	const ctx: SyncContext = { home, cwd: home, env };

	return {
		ctx,
		home,
		claudeHome,
		claudeSkills,
		claudeAgents,
		claudeSettings,
		codexHome,
		config,
		hooks,
		agentsHome,
		pluginSkills,
		hooksRoot,
		codexSkillsDir: join(codexHome, "skills"),
		codexAgentsDir: join(codexHome, "agents"),
		demoSkill: join(codexHome, "skills", "demo", "SKILL.md"),
		vizSkill: join(codexHome, "skills", "viz", "SKILL.md"),
		jsAgent: join(codexHome, "agents", "js.md"),
		qaCodeAgent: join(codexHome, "agents", "qa-code.md"),
		checkpointAgent: join(codexHome, "agents", "checkpoint.md"),
	};
}

describe("sync codex probe and dry-run", () => {
	test("probe reports source/target state without writing", async () => {
		const fx = buildFixture();
		const report = await codexTarget.probe(fx.ctx, {});
		expect(report.render()).toContain("dg-skills sync codex probe");
		expect(existsSync(fx.codexSkillsDir)).toBe(false);
	});

	test("dry-run reports planned operations without mutating config or hooks", async () => {
		const fx = buildFixture();
		const configBefore = readFileSync(fx.config, "utf8");
		const hooksBefore = readFileSync(fx.hooks, "utf8");

		const report = await codexTarget.dryRun(fx.ctx, {});

		expect(report.render()).toContain("Planned operations");
		expect(report.render()).toContain(`translate Claude statusLine.command into [tui].${STATUS_LINE}`);
		expect(readFileSync(fx.config, "utf8")).toBe(configBefore);
		expect(readFileSync(fx.hooks, "utf8")).toBe(hooksBefore);
		expect(existsSync(fx.codexSkillsDir)).toBe(false);
		expect(existsSync(fx.codexAgentsDir)).toBe(false);
	});
});

describe("sync codex apply", () => {
	test("translates status line, Context7, and hooks while preserving unrelated config/hook content", async () => {
		const fx = buildFixture();

		const report = await codexTarget.apply(fx.ctx, {});

		expect(report.ok).toBe(true);
		expect(report.render()).toContain("Verification OK");

		const config = readFileSync(fx.config, "utf8");
		const configLines = config.split("\n");
		expect(configLines).toContain("[tui]");
		expect(configLines).toContain(STATUS_LINE);
		expect(configLines).toContain(TERMINAL_TITLE);
		expect(config).not.toContain("status_line_use_colors");
		expect(config).toContain('approval_policy = "on-request"');
		expect(config).toContain('[projects."/workspace"]');
		expect(configLines).toContain("[mcp_servers.context7]");
		expect(configLines).toContain('args = ["-y", "@upstash/context7-mcp"]');
		expect(configLines).toContain('env_vars = ["CONTEXT7_API_KEY"]');
		expect(config).not.toContain("--api-key");
		expect(config).not.toContain("ctx7sk-");

		const hooks = JSON.parse(readFileSync(fx.hooks, "utf8")) as HooksJson;
		const preCommands = hooks.hooks.PreToolUse.flatMap((group) => group.hooks.map((hook) => hook.command));
		expect(preCommands).toContain(join(fx.hooksRoot, "rtk-codex-hook.sh"));
		expect(preCommands).not.toContain("rtk hook claude");
		expect(preCommands).toContain(join(fx.hooksRoot, "pr-prose-hook.sh"));
		expect(hooks.hooks.PostToolUse).toEqual([
			{ matcher: "apply_patch", hooks: [{ type: "command", command: join(fx.hooksRoot, "format-hook.sh") }] },
		]);
		expect(JSON.stringify(hooks)).not.toContain("lint-hook.sh");

		const codexSyncLink = join(fx.codexSkillsDir, "codex-sync");
		expect(lstatSync(codexSyncLink).isSymbolicLink()).toBe(true);
		expect(realpathSync(codexSyncLink)).toBe(realpathSync(join(fx.pluginSkills, "codex-sync")));

		const demoBody = readFileSync(fx.demoSkill, "utf8");
		expect(demoBody).toContain("/tmp/ai/demo/");
		expect(demoBody).not.toContain("/tmp/claude");

		const vizBody = readFileSync(fx.vizSkill, "utf8");
		expect(vizBody.startsWith("---\n")).toBe(true);
		expect(vizBody).toContain('name: "viz"');
	});

	test("translates Claude agent model tiers to Codex GPT-5.6 tiers without touching the Claude source", async () => {
		const fx = buildFixture();

		await codexTarget.apply(fx.ctx, {});

		expect(readFileSync(fx.jsAgent, "utf8")).toContain("model: gpt-5.6-terra");
		expect(readFileSync(fx.qaCodeAgent, "utf8")).toContain("model: gpt-5.6-sol");
		expect(readFileSync(fx.checkpointAgent, "utf8")).toContain('model: "gpt-5.6-luna"');
		expect(readFileSync(join(fx.claudeAgents, "js.md"), "utf8")).toContain("model: sonnet");
	});

	test("is idempotent and preserves unrelated hook groups across a second apply", async () => {
		const fx = buildFixture();

		const first = await codexTarget.apply(fx.ctx, {});
		expect(first.ok).toBe(true);
		const configAfterFirst = readFileSync(fx.config, "utf8");
		const hooksAfterFirst = readFileSync(fx.hooks, "utf8");

		const second = await codexTarget.apply(fx.ctx, {});

		expect(second.ok).toBe(true);
		expect(readFileSync(fx.config, "utf8")).toBe(configAfterFirst);
		expect(readFileSync(fx.hooks, "utf8")).toBe(hooksAfterFirst);
		expect(hooksAfterFirst).toContain("pr-prose-hook.sh");
	});

	test("removes hooks removed from Claude while preserving unrelated Codex-only hooks", async () => {
		const fx = buildFixture();
		await codexTarget.apply(fx.ctx, {});

		const hooksJson = JSON.parse(readFileSync(fx.hooks, "utf8")) as HooksJson;
		hooksJson.hooks.PreToolUse.push({
			matcher: "Bash",
			hooks: [{ type: "command", command: join(fx.hooksRoot, "fff-prefer-hook.sh") }],
		});
		hooksJson.hooks.PreToolUse.push({ matcher: "Bash", hooks: [{ type: "command", command: "/custom/hook.sh" }] });
		writeFileSync(fx.hooks, JSON.stringify(hooksJson));

		const settings = JSON.parse(readFileSync(fx.claudeSettings, "utf8")) as { hooks: HooksJson["hooks"] };
		settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(
			(group) => !group.hooks.some((hook) => hook.command.endsWith("pr-prose-hook.sh")),
		);
		writeFileSync(fx.claudeSettings, JSON.stringify(settings));

		const report = await codexTarget.apply(fx.ctx, {});

		expect(report.ok).toBe(true);
		const updated = readFileSync(fx.hooks, "utf8");
		expect(updated).not.toContain("fff-prefer-hook.sh");
		expect(updated).not.toContain("pr-prose-hook.sh");
		expect(updated).toContain("/custom/hook.sh");
	});

	test("converts a hosted Context7 server to bearer_token_env_var", async () => {
		const fx = buildFixture();
		writeFileSync(
			fx.config,
			[
				'approval_policy = "on-request"',
				"",
				"[mcp_servers.context7]",
				'url = "https://mcp.context7.com/mcp"',
				'env_vars = ["CONTEXT7_API_KEY"]',
				"",
			].join("\n"),
		);

		const report = await codexTarget.apply(fx.ctx, {});

		expect(report.ok).toBe(true);
		const config = readFileSync(fx.config, "utf8");
		expect(config.split("\n")).toContain('bearer_token_env_var = "CONTEXT7_API_KEY"');
		expect(config.split("\n")).not.toContain('env_vars = ["CONTEXT7_API_KEY"]');
		expect(config).not.toContain("--api-key");
		expect(config).not.toContain("ctx7sk-");
	});

	test("shortens an overlong skill description to the first sentence, word-boundary-capped at 180 chars", async () => {
		const fx = buildFixture();
		const skillDir = join(fx.claudeSkills, "long");
		mkdirSync(skillDir, { recursive: true });
		const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
		writeFileSync(join(skillDir, "SKILL.md"), `---\nname: long\ndescription: ${words}.\n---\n`);

		await codexTarget.apply(fx.ctx, {});

		const imported = readFileSync(join(fx.codexSkillsDir, "long", "SKILL.md"), "utf8");
		const match = imported.match(/^description: (.*)$/m);
		expect(match).not.toBeNull();
		const description = JSON.parse((match as RegExpMatchArray)[1]) as string;
		expect(description.length).toBeLessThanOrEqual(180);
		expect(description.endsWith("…")).toBe(true);
		expect(words.startsWith(description.slice(0, -1))).toBe(true);
	});

	test("prunes a skill removed from Claude while keeping a skill that was never dg-sync-managed", async () => {
		const fx = buildFixture();
		await codexTarget.apply(fx.ctx, {});
		expect(existsSync(fx.demoSkill)).toBe(true);

		mkdirSync(join(fx.codexSkillsDir, "codex-owned"), { recursive: true });
		writeFileSync(join(fx.codexSkillsDir, "codex-owned", "SKILL.md"), "---\nname: codex-owned\ndescription: Own.\n---\n");

		rmSync(join(fx.claudeSkills, "demo"), { recursive: true, force: true });
		const report = await codexTarget.apply(fx.ctx, {});

		expect(report.render()).toContain("pruned stale skill: demo");
		expect(existsSync(join(fx.codexSkillsDir, "demo"))).toBe(false);
		expect(existsSync(join(fx.codexSkillsDir, "codex-owned"))).toBe(true);
	});

	test("skips and prunes a skill duplicated under the shared agentsHome skills directory", async () => {
		const fx = buildFixture();
		await codexTarget.apply(fx.ctx, {});
		expect(existsSync(fx.demoSkill)).toBe(true);

		const shared = join(fx.agentsHome, "skills", "demo");
		mkdirSync(shared, { recursive: true });
		writeFileSync(join(shared, "SKILL.md"), "---\nname: demo\ndescription: Shared.\n---\n");
		const report = await codexTarget.apply(fx.ctx, {});

		expect(report.render()).toContain("pruned duplicate of");
		expect(existsSync(join(fx.codexSkillsDir, "demo"))).toBe(false);
		expect(existsSync(shared)).toBe(true);
	});

	test("bootstraps a missing Codex hooks file when HOOKS_ROOT is configured", async () => {
		const fx = buildFixture();
		rmSync(fx.hooks);

		const report = await codexTarget.apply(fx.ctx, {});

		expect(report.render()).toContain("created missing Codex hooks file");
		expect(report.ok).toBe(true);
		const hooks = JSON.parse(readFileSync(fx.hooks, "utf8")) as HooksJson;
		expect(hooks.hooks.PreToolUse.length).toBeGreaterThan(0);
	});

	test("succeeds without HOOKS_ROOT configured and reports the skip instead of dying", async () => {
		const fx = buildFixture({ withHooksRoot: false });

		const report = await codexTarget.apply(fx.ctx, {});

		expect(report.ok).toBe(true);
		expect(report.render()).toContain(
			"hooks root not configured (set HOOKS_ROOT); skipping Claude-to-Codex hook translation",
		);
	});

	test("plugin skill wins a duplicate name over the local Claude copy, with a shadow warning", async () => {
		const fx = buildFixture();
		mkdirSync(join(fx.pluginSkills, "demo"), { recursive: true });
		writeFileSync(
			join(fx.pluginSkills, "demo", "SKILL.md"),
			["---", "name: demo", "description: Plugin demo.", "---", "", "plugin content", ""].join("\n"),
		);

		const report = await codexTarget.apply(fx.ctx, {});

		expect(report.ok).toBe(true);
		expect(report.render()).toContain("plugin skill 'demo' shadows a local copy under the Claude skills directory");
		const imported = readFileSync(fx.demoSkill, "utf8");
		expect(imported).toContain("plugin content");
		expect(imported).not.toContain("demo-cli record");
	});

	test("never writes to Claude's own settings.json", async () => {
		const fx = buildFixture();
		const before = readFileSync(fx.claudeSettings, "utf8");

		await codexTarget.apply(fx.ctx, {});

		expect(readFileSync(fx.claudeSettings, "utf8")).toBe(before);
	});
});

describe("sync codex verify", () => {
	test("fails before reconciliation, naming each untranslated piece", async () => {
		const fx = buildFixture();

		const report = await codexTarget.verify(fx.ctx, {});

		expect(report.ok).toBe(false);
		const out = report.render();
		expect(out).toContain("Claude status line has not been translated");
		expect(out).toContain("Context7 MCP does not read CONTEXT7_API_KEY");
		expect(out).toContain("Codex hooks differ from Claude-compatible hooks");
		expect(out).toContain("Codex skills directory is missing");
		expect(out).toContain("Codex agents directory is missing");
	});

	test("fails when an imported skill loses its YAML frontmatter", async () => {
		const fx = buildFixture();
		await codexTarget.apply(fx.ctx, {});
		writeFileSync(fx.vizSkill, "# /viz\n\nBroken.\n");

		const report = await codexTarget.verify(fx.ctx, {});

		expect(report.ok).toBe(false);
		expect(report.render()).toContain("is missing YAML frontmatter delimited by ---");
		expect(report.render()).toContain("Codex skills include invalid SKILL.md frontmatter");
	});

	test("fails when an imported agent's model is reverted to a Claude tier", async () => {
		const fx = buildFixture();
		await codexTarget.apply(fx.ctx, {});
		writeFileSync(fx.jsAgent, readFileSync(fx.jsAgent, "utf8").replace("model: gpt-5.6-terra", "model: sonnet"));

		const report = await codexTarget.verify(fx.ctx, {});

		expect(report.ok).toBe(false);
		expect(report.render()).toContain("Codex subagents still use Claude model tiers");
	});
});

describe("sync codex parseFlags", () => {
	test("accepts no flags", () => {
		expect(codexTarget.parseFlags([])).toEqual({ flags: {} });
	});

	test("rejects any option", () => {
		const result = codexTarget.parseFlags(["--bogus"]);
		expect(result.error).toBe("unknown option: --bogus");
	});
});
