import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opencodeTarget } from "../../src/sync/opencode";
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
	configHome: string;
	pluginSkills: string;
}

function scaffold(): Fixture {
	const home = mkdtempSync(join(tmpdir(), "sync-opencode-home-"));
	tmpDirs.push(home);
	const claudeHome = join(home, ".claude");
	const claudeSkills = join(claudeHome, "skills");
	const claudeAgents = join(claudeHome, "agents");
	const configHome = join(home, ".config", "opencode");
	const pluginRoot = mkdtempSync(join(tmpdir(), "sync-opencode-plugin-"));
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
			HOME: home,
			DG_HOME: join(home, ".dg"),
			DG_SKILLS_DIR: pluginSkills,
			SKILLS_SRC: claudeSkills,
			AGENTS_SRC: claudeAgents,
			CONFIG_HOME: configHome,
			AI_SCRATCH_DIR: "/tmp/ai-test-opencode",
			AI_STATE_DIR: join(home, ".local", "state", "ai"),
		},
	};
	return { ctx, home, claudeSkills, claudeAgents, configHome, pluginSkills };
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

function writeOpencodeConfig(configHome: string, data: Record<string, unknown>): void {
	mkdirSync(configHome, { recursive: true });
	writeFileSync(join(configHome, "opencode.json"), JSON.stringify(data));
}

describe("sync opencode apply", () => {
	test("succeeds with nothing configured", async () => {
		const { ctx } = scaffold();
		const report = await opencodeTarget.apply(ctx, { syncDtf: false });
		expect(report.ok).toBe(true);
		expect(report.render()).toContain("agents: 0");
		expect(report.render()).toContain("skills: 0");
	});

	test("transforms a source agent into opencode .md format", async () => {
		const { ctx, claudeAgents, configHome } = scaffold();
		writeAgent(claudeAgents, "test-agent");
		await opencodeTarget.apply(ctx, { syncDtf: false });
		const out = join(configHome, "agents", "test-agent.md");
		expect(existsSync(out)).toBe(true);
		const content = readFileSync(out, "utf8");
		expect(content).toContain("description:");
		expect(content).toContain("mode: subagent");
		expect(content).toContain("You are test-agent.");
	});

	test("copies merged skills, normalizes frontmatter, and rewrites scratch paths", async () => {
		const { ctx, claudeSkills, configHome } = scaffold();
		writeSkill(claudeSkills, "rewrite-skill", "Scratch: /tmp/claude/output.txt");
		const report = await opencodeTarget.apply(ctx, { syncDtf: false });
		expect(report.ok).toBe(true);
		const copied = readFileSync(join(configHome, "skills", "rewrite-skill", "SKILL.md"), "utf8");
		expect(copied).toContain("/tmp/ai-test-opencode/output.txt");
		expect(copied).not.toContain("/tmp/claude");
	});

	test("plugin skill wins a duplicate name over the local copy, with a shadow warning, and never deletes the local source", async () => {
		const { ctx, claudeSkills, configHome, pluginSkills } = scaffold();
		writeSkill(claudeSkills, "shared-name", "local content");
		writeSkill(pluginSkills, "shared-name", "plugin content");
		const report = await opencodeTarget.apply(ctx, { syncDtf: false });
		expect(report.ok).toBe(true);
		expect(report.render()).toContain("plugin skill 'shared-name' shadows a local copy");
		const copied = readFileSync(join(configHome, "skills", "shared-name", "SKILL.md"), "utf8");
		expect(copied).toContain("plugin content");
		const localSource = readFileSync(join(claudeSkills, "shared-name", "SKILL.md"), "utf8");
		expect(localSource).toContain("local content");
	});

	test("plugin agent wins a duplicate name over the local copy, with a shadow warning", async () => {
		const { ctx, claudeAgents, pluginSkills } = scaffold();
		const pluginAgents = join(pluginSkills, "..", "agents");
		mkdirSync(pluginAgents, { recursive: true });
		writeAgent(claudeAgents, "shared-agent", "sonnet");
		writeFileSync(
			join(pluginAgents, "shared-agent.md"),
			["---", "name: shared-agent", 'description: "Plugin agent."', "---", "", "Plugin persona.", ""].join("\n"),
		);
		const report = await opencodeTarget.apply(ctx, { syncDtf: false });
		expect(report.ok).toBe(true);
		expect(report.render()).toContain("plugin agent 'shared-agent' shadows a local copy");
	});

	test("bounded pruning removes a stale agent no longer produced and leaves a foreign file alone", async () => {
		const { ctx, claudeAgents, configHome } = scaffold();
		writeAgent(claudeAgents, "temp-agent");
		await opencodeTarget.apply(ctx, { syncDtf: false });
		expect(existsSync(join(configHome, "agents", "temp-agent.md"))).toBe(true);

		writeFileSync(join(configHome, "agents", "foreign.md"), "not ours");
		rmSync(join(claudeAgents, "temp-agent.md"));
		const report = await opencodeTarget.apply(ctx, { syncDtf: false });
		expect(report.render()).toContain("1 pruned");
		expect(existsSync(join(configHome, "agents", "temp-agent.md"))).toBe(false);
		expect(existsSync(join(configHome, "agents", "foreign.md"))).toBe(true);
	});

	test("skips hooks with a warning when no hooks source is configured", async () => {
		const { ctx } = scaffold();
		const report = await opencodeTarget.apply(ctx, { syncDtf: false });
		expect(report.render()).toContain("no hooks source configured");
	});

	test("copies hooks from a configured source and prunes a removed one", async () => {
		const { ctx, configHome, home } = scaffold();
		const hooksSrc = join(home, "hooks-src");
		mkdirSync(hooksSrc, { recursive: true });
		writeFileSync(join(hooksSrc, "pre.sh"), "#!/usr/bin/env bash\n");
		ctx.env.OPENCODE_HOOKS_SRC = hooksSrc;
		await opencodeTarget.apply(ctx, { syncDtf: false });
		expect(existsSync(join(configHome, "hooks", "pre.sh"))).toBe(true);

		rmSync(join(hooksSrc, "pre.sh"));
		const report = await opencodeTarget.apply(ctx, { syncDtf: false });
		expect(report.render()).toContain("1 pruned");
		expect(existsSync(join(configHome, "hooks", "pre.sh"))).toBe(false);
	});

	test("skips plugins with a warning when no plugins source is configured", async () => {
		const { ctx } = scaffold();
		const report = await opencodeTarget.apply(ctx, { syncDtf: false });
		expect(report.render()).toContain("no plugins source configured");
	});

	test("copies plugin directories from a configured source", async () => {
		const { ctx, configHome, home } = scaffold();
		const pluginsSrc = join(home, "plugins-src");
		mkdirSync(join(pluginsSrc, "my-plugin"), { recursive: true });
		writeFileSync(join(pluginsSrc, "my-plugin", "index.ts"), "export default {};\n");
		ctx.env.OPENCODE_PLUGINS_SRC = pluginsSrc;
		const report = await opencodeTarget.apply(ctx, { syncDtf: false });
		expect(report.ok).toBe(true);
		expect(existsSync(join(configHome, "plugins", "my-plugin", "index.ts"))).toBe(true);
	});

	test("registers the expected plugins into an existing opencode.json without duplicating entries", async () => {
		const { ctx, configHome } = scaffold();
		writeOpencodeConfig(configHome, { plugin: ["american-english-hook"] });
		const report = await opencodeTarget.apply(ctx, { syncDtf: false });
		expect(report.ok).toBe(true);
		const config = JSON.parse(readFileSync(join(configHome, "opencode.json"), "utf8"));
		expect(config.plugin).toContain("american-english-hook");
		expect(config.plugin).toContain("format-hook");
		expect(config.plugin.filter((p: string) => p === "american-english-hook")).toHaveLength(1);
	});

	test("warns when opencode.json does not exist", async () => {
		const { ctx } = scaffold();
		const report = await opencodeTarget.apply(ctx, { syncDtf: false });
		expect(report.render()).toContain("no opencode.json");
	});

	test("--sync-dtf is accepted but has no effect", async () => {
		const { ctx } = scaffold();
		const report = await opencodeTarget.apply(ctx, { syncDtf: true });
		expect(report.ok).toBe(true);
		expect(report.render()).toContain("--sync-dtf has no effect");
	});

	test("double apply is idempotent for the plugin list", async () => {
		const { ctx, configHome } = scaffold();
		writeOpencodeConfig(configHome, { plugin: [] });
		await opencodeTarget.apply(ctx, { syncDtf: false });
		const after1 = readFileSync(join(configHome, "opencode.json"), "utf8");
		const r2 = await opencodeTarget.apply(ctx, { syncDtf: false });
		expect(r2.ok).toBe(true);
		const after2 = readFileSync(join(configHome, "opencode.json"), "utf8");
		expect(after2).toBe(after1);
	});
});

describe("sync opencode required secrets", () => {
	test("apply fails and syncs nothing when a referenced MCP env var has no stored credential", async () => {
		const { ctx, configHome, claudeSkills } = scaffold();
		writeSkill(claudeSkills, "some-skill");
		writeOpencodeConfig(configHome, {
			mcp: { context7: { env: { CONTEXT7_API_KEY: "${CONTEXT7_API_KEY}" } } },
		});
		const report = await opencodeTarget.apply(ctx, { syncDtf: false });
		expect(report.ok).toBe(false);
		expect(report.render()).toContain("missing secret: run `~/.dg/bin/dg-skills credentials set sync/context7-api-key` for CONTEXT7_API_KEY");
		expect(existsSync(join(configHome, "skills", "some-skill"))).toBe(false);
	});

	test("apply proceeds normally when the MCP config has no ${VAR} references", async () => {
		const { ctx, configHome } = scaffold();
		writeOpencodeConfig(configHome, { mcp: { context7: { env: { CONTEXT7_API_KEY: "literal-but-not-a-reference" } } } });
		const report = await opencodeTarget.apply(ctx, { syncDtf: false });
		expect(report.ok).toBe(true);
	});
});

describe("sync opencode verify", () => {
	test("fails when a synced agent is missing its description field", async () => {
		const { ctx, configHome } = scaffold();
		mkdirSync(join(configHome, "agents"), { recursive: true });
		writeFileSync(join(configHome, "agents", "broken.md"), "---\nname: broken\n---\n\nNo description.\n");
		const report = await opencodeTarget.verify(ctx, { syncDtf: false });
		expect(report.ok).toBe(false);
		expect(report.render()).toContain("agent invalid (missing description): broken.md");
	});

	test("fails when a synced skill's frontmatter is invalid", async () => {
		const { ctx, configHome } = scaffold();
		mkdirSync(join(configHome, "skills", "broken"), { recursive: true });
		writeFileSync(join(configHome, "skills", "broken", "SKILL.md"), "no frontmatter here\n");
		const report = await opencodeTarget.verify(ctx, { syncDtf: false });
		expect(report.ok).toBe(false);
		expect(report.render()).toContain("skill invalid: broken");
	});

	test("fails when a config file contains a secret-shaped literal", async () => {
		const { ctx, configHome } = scaffold();
		const fakeToken = `ghp_${randomBytes(18).toString("hex").slice(0, 36)}`;
		writeOpencodeConfig(configHome, { mcp: { context7: { env: { CONTEXT7_API_KEY: fakeToken } } } });
		const report = await opencodeTarget.verify(ctx, { syncDtf: false });
		expect(report.ok).toBe(false);
		expect(report.render()).toContain("secret-wall");
	});

	test("passes when nothing has been synced yet", async () => {
		const { ctx } = scaffold();
		const report = await opencodeTarget.verify(ctx, { syncDtf: false });
		expect(report.ok).toBe(true);
	});
});

describe("sync opencode probe and dry-run", () => {
	test("probe reports the compatibility matrix and makes no writes", async () => {
		const { ctx, configHome } = scaffold();
		const report = await opencodeTarget.probe(ctx, { syncDtf: false });
		expect(report.render()).toContain("Compatibility matrix");
		expect(existsSync(configHome)).toBe(false);
	});

	test("dry-run reports planned operations and makes no writes", async () => {
		const { ctx, configHome } = scaffold();
		const report = await opencodeTarget.dryRun(ctx, { syncDtf: false });
		expect(report.render()).toContain("Planned operations");
		expect(existsSync(join(configHome, "skills"))).toBe(false);
	});
});

describe("sync opencode parseFlags", () => {
	test("accepts --sync-dtf", () => {
		expect(opencodeTarget.parseFlags(["--sync-dtf"])).toEqual({ flags: { syncDtf: true } });
	});

	test("accepts no flags", () => {
		expect(opencodeTarget.parseFlags([])).toEqual({ flags: { syncDtf: false } });
	});

	test("rejects an unknown option", () => {
		const result = opencodeTarget.parseFlags(["--bogus"]);
		expect(result.error).toBeDefined();
	});
});
