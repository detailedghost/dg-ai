import { afterEach, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copilotTarget } from "../../src/sync/copilot";
import type { SyncContext } from "../../src/sync/types";

const tmpDirs: string[] = [];

afterEach(() => {
	for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
	ctx: SyncContext;
	home: string;
	claudeSkills: string;
	claudeAgents: string;
	copilotHome: string;
	pluginSkills: string;
}

function scaffold(): Fixture {
	const home = mkdtempSync(join(tmpdir(), "sync-copilot-home-"));
	tmpDirs.push(home);
	const claudeHome = join(home, ".claude");
	const claudeSkills = join(claudeHome, "skills");
	const claudeAgents = join(claudeHome, "agents");
	const copilotHome = join(home, ".copilot");
	const pluginRoot = mkdtempSync(join(tmpdir(), "sync-copilot-plugin-"));
	tmpDirs.push(pluginRoot);
	const pluginSkills = join(pluginRoot, "skills");
	mkdirSync(pluginSkills, { recursive: true });
	mkdirSync(claudeSkills, { recursive: true });
	mkdirSync(claudeAgents, { recursive: true });

	const ctx: SyncContext = {
		home,
		cwd: home,
		env: {
			...process.env,
			DG_SKILLS_DIR: pluginSkills,
			SKILLS_SRC: claudeSkills,
			AGENTS_SRC: claudeAgents,
			COPILOT_HOME: copilotHome,
			AI_SCRATCH_DIR: "/tmp/ai-test-copilot",
			AI_STATE_DIR: join(home, ".local", "state", "ai"),
		},
	};
	return { ctx, home, claudeSkills, claudeAgents, copilotHome, pluginSkills };
}

function writeSkill(dir: string, name: string, body = "Body."): void {
	mkdirSync(join(dir, name), { recursive: true });
	writeFileSync(
		join(dir, name, "SKILL.md"),
		["---", `name: ${name}`, `description: ${name} skill.`, "---", "", body, ""].join("\n"),
	);
}

function writeAgent(dir: string, name: string, model = "opus"): void {
	writeFileSync(
		join(dir, `${name}.md`),
		["---", `name: ${name}`, `description: "${name} agent."`, `model: ${model}`, "---", "", `You are ${name}.`, ""].join("\n"),
	);
}

describe("sync copilot apply", () => {
	test("succeeds and verification passes", async () => {
		const { ctx } = scaffold();
		const report = await copilotTarget.apply(ctx, { copySkills: false });
		expect(report.ok).toBe(true);
		expect(report.render()).toContain("Verification OK");
	});

	test("transforms source agents into .agent.md files", async () => {
		const { ctx, claudeAgents, copilotHome } = scaffold();
		writeAgent(claudeAgents, "test-agent");
		await copilotTarget.apply(ctx, { copySkills: false });
		const out = join(copilotHome, "agents", "test-agent.agent.md");
		expect(existsSync(out)).toBe(true);
		const content = readFileSync(out, "utf8");
		expect(content).toContain('name: "test-agent"');
		expect(content).toContain("You are test-agent.");
	});

	test("creates a skills symlink pointing at the single source when the plugin contributes nothing", async () => {
		const { ctx, claudeSkills, copilotHome } = scaffold();
		const emptyPluginRoot = mkdtempSync(join(tmpdir(), "sync-copilot-empty-plugin-"));
		tmpDirs.push(emptyPluginRoot);
		ctx.env.DG_SKILLS_DIR = join(emptyPluginRoot, "skills");
		mkdirSync(ctx.env.DG_SKILLS_DIR, { recursive: true });
		writeSkill(claudeSkills, "local-only");
		await copilotTarget.apply(ctx, { copySkills: false });
		const link = join(copilotHome, "skills");
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
		expect(readlinkSync(link)).toBe(claudeSkills);
	});

	test("writes hooks.json with version 1 schema even with no hook scripts configured", async () => {
		const { ctx, copilotHome } = scaffold();
		await copilotTarget.apply(ctx, { copySkills: false });
		const hooks = JSON.parse(readFileSync(join(copilotHome, "hooks", "hooks.json"), "utf8"));
		expect(hooks.version).toBe(1);
		expect(hooks.hooks.preToolUse).toEqual([]);
		expect(hooks.hooks.postToolUse).toEqual([]);
	});

	test("wires configured hook scripts into hooks.json", async () => {
		const { ctx, copilotHome } = scaffold();
		const pre = join(copilotHome, "pre.sh");
		mkdirSync(copilotHome, { recursive: true });
		writeFileSync(pre, "#!/usr/bin/env bash\n");
		ctx.env.COPILOT_PRETOOLUSE_HOOK = pre;
		const report = await copilotTarget.apply(ctx, { copySkills: false });
		expect(report.ok).toBe(true);
		const hooks = JSON.parse(readFileSync(join(copilotHome, "hooks", "hooks.json"), "utf8"));
		expect(hooks.hooks.preToolUse).toEqual([{ type: "command", bash: pre }]);
	});

	test("writes copilot-instructions.md from CLAUDE.md with scratch-path rewrite", async () => {
		const { ctx, home, copilotHome } = scaffold();
		mkdirSync(join(home, ".claude"), { recursive: true });
		writeFileSync(join(home, ".claude", "CLAUDE.md"), "# Instructions\nScratch dir: /tmp/claude/work");
		await copilotTarget.apply(ctx, { copySkills: false });
		const out = readFileSync(join(copilotHome, "copilot-instructions.md"), "utf8");
		expect(out).toContain("Instructions");
		expect(out).toContain("/tmp/ai-test-copilot/work");
		expect(out).not.toContain("/tmp/claude");
	});

	test("adds the scratch and state roots to trustedFolders", async () => {
		const { ctx, copilotHome } = scaffold();
		await copilotTarget.apply(ctx, { copySkills: false });
		const config = JSON.parse(readFileSync(join(copilotHome, "config.json"), "utf8"));
		expect(config.trustedFolders).toContain("/tmp/ai-test-copilot");
	});

	test("wires statusLine only when a statusline script is configured and present", async () => {
		const { ctx, copilotHome } = scaffold();
		const script = join(copilotHome, "statusline.sh");
		mkdirSync(copilotHome, { recursive: true });
		writeFileSync(script, "#!/usr/bin/env bash\necho '{}'");
		ctx.env.COPILOT_STATUSLINE_SCRIPT = script;
		const report = await copilotTarget.apply(ctx, { copySkills: false });
		expect(report.ok).toBe(true);
		const config = JSON.parse(readFileSync(join(copilotHome, "config.json"), "utf8"));
		expect(config.statusLine.command).toContain(script);
	});

	test("preserves a leading JSONC comment header in config.json", async () => {
		const { ctx, copilotHome } = scaffold();
		mkdirSync(copilotHome, { recursive: true });
		writeFileSync(
			join(copilotHome, "config.json"),
			["// Managed automatically.", JSON.stringify({ trustedFolders: ["/existing"] })].join("\n"),
		);
		await copilotTarget.apply(ctx, { copySkills: false });
		const out = readFileSync(join(copilotHome, "config.json"), "utf8");
		expect(out.startsWith("// Managed automatically.")).toBe(true);
		const json = JSON.parse(out.split("\n").slice(1).join("\n"));
		expect(json.trustedFolders).toContain("/existing");
		expect(json.trustedFolders).toContain("/tmp/ai-test-copilot");
	});

	test("double apply is idempotent", async () => {
		const { ctx, copilotHome } = scaffold();
		await copilotTarget.apply(ctx, { copySkills: false });
		const after1 = readFileSync(join(copilotHome, "config.json"), "utf8");
		const r2 = await copilotTarget.apply(ctx, { copySkills: false });
		expect(r2.ok).toBe(true);
		const after2 = readFileSync(join(copilotHome, "config.json"), "utf8");
		expect(after2).toBe(after1);
	});
});

describe("sync copilot MCP merge", () => {
	function writeClaudeJson(home: string, servers: Record<string, unknown>): void {
		writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: servers }));
	}

	test("normalizes a Claude stdio server to local type", async () => {
		const { ctx, home, copilotHome } = scaffold();
		writeClaudeJson(home, { "my-tool": { type: "stdio", command: "my-tool-bin", args: ["--flag"], enabled: true } });
		await copilotTarget.apply(ctx, { copySkills: false });
		const mcp = JSON.parse(readFileSync(join(copilotHome, "mcp-config.json"), "utf8"));
		expect(mcp.mcpServers["my-tool"]).toEqual({ type: "local", command: "my-tool-bin", args: ["--flag"], env: {} });
	});

	test("excludes a disabled Claude MCP server", async () => {
		const { ctx, home, copilotHome } = scaffold();
		writeClaudeJson(home, { "disabled-tool": { type: "stdio", command: "bin", enabled: false } });
		await copilotTarget.apply(ctx, { copySkills: false });
		const mcp = JSON.parse(readFileSync(join(copilotHome, "mcp-config.json"), "utf8"));
		expect(mcp.mcpServers["disabled-tool"]).toBeUndefined();
	});

	test("strips the --headful flag from merged playwright args", async () => {
		const { ctx, home, copilotHome } = scaffold();
		writeClaudeJson(home, {
			playwright: { type: "stdio", command: "playwright-mcp", args: ["--headless", "--headful"], enabled: true },
		});
		await copilotTarget.apply(ctx, { copySkills: false });
		const mcp = JSON.parse(readFileSync(join(copilotHome, "mcp-config.json"), "utf8"));
		expect(mcp.mcpServers.playwright.args).not.toContain("--headful");
		expect(mcp.mcpServers.playwright.args).toContain("--headless");
	});

	test("an existing Copilot MCP entry wins over an incoming Claude one on key conflict", async () => {
		const { ctx, home, copilotHome } = scaffold();
		mkdirSync(copilotHome, { recursive: true });
		writeFileSync(
			join(copilotHome, "mcp-config.json"),
			JSON.stringify({ mcpServers: { shared: { type: "local", command: "copilot-version", args: [] } } }),
		);
		writeClaudeJson(home, { shared: { type: "stdio", command: "claude-version", args: [], enabled: true } });
		await copilotTarget.apply(ctx, { copySkills: false });
		const mcp = JSON.parse(readFileSync(join(copilotHome, "mcp-config.json"), "utf8"));
		expect(mcp.mcpServers.shared.command).toBe("copilot-version");
	});

	test("maps an OpenCode local array-command server to local type", async () => {
		const { ctx, home, copilotHome } = scaffold();
		mkdirSync(join(home, ".config", "opencode"), { recursive: true });
		writeFileSync(
			join(home, ".config", "opencode", "opencode.json"),
			JSON.stringify({ mcp: { "oc-tool": { type: "local", command: ["oc-bin", "--port", "9000"], enabled: true } } }),
		);
		await copilotTarget.apply(ctx, { copySkills: false });
		const mcp = JSON.parse(readFileSync(join(copilotHome, "mcp-config.json"), "utf8"));
		expect(mcp.mcpServers["oc-tool"]).toEqual({ type: "local", command: "oc-bin", args: ["--port", "9000"], env: {} });
	});
});

describe("sync copilot --copy-skills and merged sources", () => {
	test("copies merged skills and rewrites scratch paths", async () => {
		const { ctx, claudeSkills, copilotHome } = scaffold();
		writeSkill(claudeSkills, "rewrite-skill", "Scratch: /tmp/claude/output.txt");
		const r = await copilotTarget.apply(ctx, { copySkills: true });
		expect(r.ok).toBe(true);
		const skillsPath = join(copilotHome, "skills");
		expect(lstatSync(skillsPath).isSymbolicLink()).toBe(false);
		const copied = readFileSync(join(skillsPath, "rewrite-skill", "SKILL.md"), "utf8");
		expect(copied).toContain("/tmp/ai-test-copilot/output.txt");
		expect(copied).not.toContain("/tmp/claude");
	});

	test("replaces an existing symlink with a directory when --copy-skills is used", async () => {
		const { ctx, claudeSkills, copilotHome } = scaffold();
		writeSkill(claudeSkills, "a-skill");
		mkdirSync(copilotHome, { recursive: true });
		const { symlinkSync } = await import("node:fs");
		symlinkSync(claudeSkills, join(copilotHome, "skills"));
		await copilotTarget.apply(ctx, { copySkills: true });
		const skillsPath = join(copilotHome, "skills");
		expect(lstatSync(skillsPath).isDirectory()).toBe(true);
		expect(lstatSync(skillsPath).isSymbolicLink()).toBe(false);
	});

	test("plugin skill wins a duplicate name over the local copy, with a shadow warning, and never deletes the local source", async () => {
		const { ctx, claudeSkills, copilotHome } = scaffold();
		writeSkill(claudeSkills, "shared-name", "local content");
		writeSkill(ctx.env.DG_SKILLS_DIR as string, "shared-name", "plugin content");
		const report = await copilotTarget.apply(ctx, { copySkills: false });
		expect(report.ok).toBe(true);
		expect(report.render()).toContain("plugin skill 'shared-name' shadows a local copy");
		const copied = readFileSync(join(copilotHome, "skills", "shared-name", "SKILL.md"), "utf8");
		expect(copied).toContain("plugin content");
		const localSource = readFileSync(join(claudeSkills, "shared-name", "SKILL.md"), "utf8");
		expect(localSource).toContain("local content");
	});

	test("bounded pruning removes a skill no longer in the merged source set and leaves a foreign directory alone", async () => {
		const { ctx, claudeSkills, copilotHome } = scaffold();
		writeSkill(claudeSkills, "will-be-removed");
		await copilotTarget.apply(ctx, { copySkills: true });
		expect(existsSync(join(copilotHome, "skills", "will-be-removed"))).toBe(true);

		mkdirSync(join(copilotHome, "skills", "foreign"), { recursive: true });
		writeFileSync(join(copilotHome, "skills", "foreign", "SKILL.md"), "not ours");

		rmSync(join(claudeSkills, "will-be-removed"), { recursive: true, force: true });
		const report = await copilotTarget.apply(ctx, { copySkills: true });
		expect(report.render()).toContain("pruned stale skill: will-be-removed");
		expect(existsSync(join(copilotHome, "skills", "will-be-removed"))).toBe(false);
		expect(existsSync(join(copilotHome, "skills", "foreign"))).toBe(true);
	});

	test("bounded pruning removes a stale agent no longer produced", async () => {
		const { ctx, claudeAgents, copilotHome } = scaffold();
		writeAgent(claudeAgents, "temp-agent");
		await copilotTarget.apply(ctx, { copySkills: false });
		expect(existsSync(join(copilotHome, "agents", "temp-agent.agent.md"))).toBe(true);
		rmSync(join(claudeAgents, "temp-agent.md"));
		const report = await copilotTarget.apply(ctx, { copySkills: false });
		expect(report.render()).toContain("pruned stale agent: temp-agent");
		expect(existsSync(join(copilotHome, "agents", "temp-agent.agent.md"))).toBe(false);
	});
});

describe("sync copilot verify", () => {
	test("fails when the MCP config contains a secret-shaped literal", async () => {
		const { ctx, copilotHome } = scaffold();
		await copilotTarget.apply(ctx, { copySkills: false });
		const fakeToken = `ghp_${crypto.randomBytes(18).toString("hex").slice(0, 36)}`;
		mkdirSync(copilotHome, { recursive: true });
		writeFileSync(
			join(copilotHome, "config.json"),
			JSON.stringify({ trustedFolders: [], customField: fakeToken }),
		);
		const report = await copilotTarget.verify(ctx, { copySkills: false });
		expect(report.ok).toBe(false);
		expect(report.render()).toContain("secret-wall");
	});

	test("fails when hooks.json is missing", async () => {
		const { ctx } = scaffold();
		const report = await copilotTarget.verify(ctx, { copySkills: false });
		expect(report.ok).toBe(false);
	});

	test("fails when mcp-config.json is malformed", async () => {
		const { ctx, copilotHome } = scaffold();
		await copilotTarget.apply(ctx, { copySkills: false });
		writeFileSync(join(copilotHome, "mcp-config.json"), "not json at all");
		const report = await copilotTarget.verify(ctx, { copySkills: false });
		expect(report.ok).toBe(false);
	});
});

describe("sync copilot probe and dry-run", () => {
	test("probe reports the compatibility matrix and makes no writes", async () => {
		const { ctx, copilotHome } = scaffold();
		const report = await copilotTarget.probe(ctx, { copySkills: false });
		expect(report.render()).toContain("Compatibility matrix");
		expect(existsSync(copilotHome)).toBe(false);
	});

	test("dry-run reports planned operations and makes no writes", async () => {
		const { ctx, copilotHome } = scaffold();
		const report = await copilotTarget.dryRun(ctx, { copySkills: false });
		expect(report.render()).toContain("Planned operations");
		expect(existsSync(join(copilotHome, "skills"))).toBe(false);
	});
});

describe("sync copilot parseFlags", () => {
	test("accepts --copy-skills", () => {
		expect(copilotTarget.parseFlags(["--copy-skills"])).toEqual({ flags: { copySkills: true } });
	});

	test("rejects an unknown option", () => {
		const result = copilotTarget.parseFlags(["--bogus"]);
		expect(result.error).toBeDefined();
	});
});
