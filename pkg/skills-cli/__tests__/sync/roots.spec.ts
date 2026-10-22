import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	mergeAgentSources,
	mergeSkillSources,
	resolveClaudeAgentsRoot,
	resolveClaudeSkillsRoot,
} from "../../src/sync/roots";
import type { SyncContext } from "../../src/sync/types";

const tmpDirs: string[] = [];

afterEach(() => {
	for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function withTmp(): string {
	const d = mkdtempSync(join(tmpdir(), "roots-test-"));
	tmpDirs.push(d);
	return d;
}

function skill(root: string, name: string, body = "---\nname: x\ndescription: y\n---\n"): void {
	mkdirSync(join(root, name), { recursive: true });
	writeFileSync(join(root, name, "SKILL.md"), body);
}

describe("resolveClaudeSkillsRoot / resolveClaudeAgentsRoot", () => {
	test("defaults to <home>/.claude/skills and /agents", () => {
		const home = withTmp();
		const ctx: SyncContext = { home, cwd: home, env: {} };
		expect(resolveClaudeSkillsRoot(ctx)).toBe(join(home, ".claude", "skills"));
		expect(resolveClaudeAgentsRoot(ctx)).toBe(join(home, ".claude", "agents"));
	});

	test("SKILLS_SRC / AGENTS_SRC override the default", () => {
		const home = withTmp();
		const ctx: SyncContext = { home, cwd: home, env: { SKILLS_SRC: "/custom/skills", AGENTS_SRC: "/custom/agents" } };
		expect(resolveClaudeSkillsRoot(ctx)).toBe("/custom/skills");
		expect(resolveClaudeAgentsRoot(ctx)).toBe("/custom/agents");
	});
});

describe("mergeSkillSources", () => {
	test("plugin wins a duplicate name, local copy is reported shadowed but kept on disk", () => {
		const root = withTmp();
		const pluginRoot = join(root, "plugin");
		const localRoot = join(root, "local");
		skill(pluginRoot, "db", "---\nname: db\ndescription: plugin version\n---\n");
		skill(localRoot, "db", "---\nname: db\ndescription: local version\n---\n");
		skill(localRoot, "only-local", "---\nname: only-local\ndescription: y\n---\n");

		const { sources, shadowed } = mergeSkillSources(pluginRoot, localRoot);

		expect(shadowed).toEqual(["db"]);
		const db = sources.find((s) => s.name === "db");
		expect(db?.origin).toBe("plugin");
		expect(db?.dir).toBe(join(pluginRoot, "db"));
		expect(sources.some((s) => s.name === "only-local" && s.origin === "local")).toBe(true);

		expect(existsSync(join(localRoot, "db", "SKILL.md"))).toBe(true);
	});

	test("a null plugin root falls back to local-only sources with no shadowing", () => {
		const root = withTmp();
		const localRoot = join(root, "local");
		skill(localRoot, "a");
		skill(localRoot, "b");

		const { sources, shadowed } = mergeSkillSources(null, localRoot);

		expect(shadowed).toEqual([]);
		expect(sources.map((s) => s.name)).toEqual(["a", "b"]);
		expect(sources.every((s) => s.origin === "local")).toBe(true);
	});

	test("a null local root falls back to plugin-only sources", () => {
		const root = withTmp();
		const pluginRoot = join(root, "plugin");
		skill(pluginRoot, "a");

		const { sources, shadowed } = mergeSkillSources(pluginRoot, null);

		expect(shadowed).toEqual([]);
		expect(sources).toEqual([{ name: "a", dir: join(pluginRoot, "a"), origin: "plugin" }]);
	});

	test("both roots null or missing produces an empty merge", () => {
		expect(mergeSkillSources(null, null)).toEqual({ sources: [], shadowed: [] });
	});

	test("a directory without SKILL.md is not treated as a skill", () => {
		const root = withTmp();
		const localRoot = join(root, "local");
		mkdirSync(join(localRoot, "not-a-skill"), { recursive: true });
		skill(localRoot, "real-skill");

		const { sources } = mergeSkillSources(null, localRoot);

		expect(sources.map((s) => s.name)).toEqual(["real-skill"]);
	});

	test("results are sorted by name", () => {
		const root = withTmp();
		const localRoot = join(root, "local");
		skill(localRoot, "zeta");
		skill(localRoot, "alpha");

		const { sources } = mergeSkillSources(null, localRoot);

		expect(sources.map((s) => s.name)).toEqual(["alpha", "zeta"]);
	});
});

describe("mergeAgentSources", () => {
	function agent(root: string, name: string): void {
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, `${name}.md`), "---\nname: x\ndescription: y\n---\nBody.\n");
	}

	test("plugin wins a duplicate agent name", () => {
		const root = withTmp();
		const pluginRoot = join(root, "plugin-agents");
		const localRoot = join(root, "local-agents");
		agent(pluginRoot, "js");
		agent(localRoot, "js");
		agent(localRoot, "custom");

		const { sources, shadowed } = mergeAgentSources(pluginRoot, localRoot);

		expect(shadowed).toEqual(["js"]);
		expect(sources.find((s) => s.name === "js")?.origin).toBe("plugin");
		expect(sources.some((s) => s.name === "custom" && s.origin === "local")).toBe(true);
	});

	test("ignores non-.md files", () => {
		const root = withTmp();
		const localRoot = join(root, "local-agents");
		mkdirSync(localRoot, { recursive: true });
		writeFileSync(join(localRoot, "notes.txt"), "not an agent");
		agent(localRoot, "real");

		const { sources } = mergeAgentSources(null, localRoot);

		expect(sources.map((s) => s.name)).toEqual(["real"]);
	});
});
