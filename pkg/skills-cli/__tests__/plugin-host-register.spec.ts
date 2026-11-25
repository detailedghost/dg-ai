import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDgPaths } from "@dg/common/node/dg-paths";
import { addPlugin, removePlugin, setPluginEnabled, updatePlugin, verifyPlugin } from "../src/plugin/lifecycle";

let root: string;
let env: Record<string, string | undefined>;

const claudeSkill = (name: string) => join(root, "claude", "skills", name);
const codexSkill = (name: string) => join(root, "codex", "skills", name);

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "dg-plugin-hosts-"));
	env = {
		DG_HOME: join(root, "dg"),
		HOME: join(root, "home"),
		CLAUDE_CONFIG_DIR: join(root, "claude"),
		CODEX_HOME: join(root, "codex"),
		DG_PATH_FENCE: root,
	};
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
	const run = Bun.spawnSync(
		["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
		{ cwd, env: { PATH: process.env.PATH ?? "", HOME: root } },
	);
	if (run.exitCode !== 0) throw new Error(run.stderr.toString());
	return run.stdout.toString().trim();
}

function skillRepo(name: string): string {
	const dir = join(root, "sources", name);
	mkdirSync(join(dir, "skills", "release-notes"), { recursive: true });
	writeFileSync(join(dir, "skills", "release-notes", "SKILL.md"), "# Release notes\n");
	writeFileSync(join(dir, "skills", "release-notes", "reference.md"), "ref\n");
	git(dir, "init", "-q", "-b", "main");
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "init");
	return dir;
}

function approvedAndEnabled(): string {
	const source = skillRepo("notes");
	addPlugin({ source }, env);
	verifyPlugin("notes", { approve: true }, env);
	setPluginEnabled("notes", true, env);
	return source;
}

describe("host registration", () => {
	test("registers an approved, enabled skill with the Claude and Codex hosts", () => {
		approvedAndEnabled();
		for (const dir of [claudeSkill("release-notes"), codexSkill("release-notes")]) {
			expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toBe("# Release notes\n");
			expect(readFileSync(join(dir, "reference.md"), "utf8")).toBe("ref\n");
		}
	});

	test("registers nothing on add, on approval alone, or while disabled", () => {
		addPlugin({ source: skillRepo("notes") }, env);
		expect(existsSync(claudeSkill("release-notes"))).toBe(false);
		verifyPlugin("notes", { approve: true }, env);
		expect(existsSync(claudeSkill("release-notes"))).toBe(false);
		expect(existsSync(codexSkill("release-notes"))).toBe(false);
	});

	test("an unapproved enable throws and registers nothing", () => {
		addPlugin({ source: skillRepo("notes") }, env);
		expect(() => setPluginEnabled("notes", true, env)).toThrow(/approve/);
		expect(existsSync(claudeSkill("release-notes"))).toBe(false);
	});

	test("re-approving an enabled plugin keeps it registered", () => {
		approvedAndEnabled();
		verifyPlugin("notes", { approve: true }, env);
		expect(existsSync(claudeSkill("release-notes"))).toBe(true);
		expect(existsSync(codexSkill("release-notes"))).toBe(true);
	});

	test("disable removes the registrations", () => {
		approvedAndEnabled();
		setPluginEnabled("notes", false, env);
		expect(existsSync(claudeSkill("release-notes"))).toBe(false);
		expect(existsSync(codexSkill("release-notes"))).toBe(false);
	});

	test("remove deletes the registrations", () => {
		approvedAndEnabled();
		removePlugin("notes", env);
		expect(existsSync(claudeSkill("release-notes"))).toBe(false);
		expect(existsSync(codexSkill("release-notes"))).toBe(false);
	});

	test("a changed update drops the approval and the registrations", () => {
		const source = approvedAndEnabled();
		writeFileSync(join(source, "skills", "release-notes", "SKILL.md"), "# Changed\n");
		git(source, "commit", "-q", "-am", "change");
		updatePlugin("notes", {}, env);
		expect(existsSync(claudeSkill("release-notes"))).toBe(false);
		expect(existsSync(codexSkill("release-notes"))).toBe(false);
	});

	test("an unchanged update keeps the registrations", () => {
		approvedAndEnabled();
		updatePlugin("notes", {}, env);
		expect(existsSync(claudeSkill("release-notes"))).toBe(true);
		expect(existsSync(codexSkill("release-notes"))).toBe(true);
	});

	test("verify drops the registrations of a plugin edited on disk", () => {
		approvedAndEnabled();
		const folder = join(root, "dg");
		const edited = readdirSync(folder, { recursive: true, withFileTypes: true }).find(
			(entry) => entry.isFile() && entry.name === "SKILL.md" && entry.parentPath.includes(join("notes", "src")),
		);
		writeFileSync(join(edited?.parentPath ?? "", "SKILL.md"), "tampered\n");
		verifyPlugin("notes", { approve: false }, env);
		expect(existsSync(claudeSkill("release-notes"))).toBe(false);
		expect(existsSync(codexSkill("release-notes"))).toBe(false);
	});

	test("refuses to overwrite a skill dg did not register and leaves the plugin disabled", () => {
		addPlugin({ source: skillRepo("notes") }, env);
		verifyPlugin("notes", { approve: true }, env);
		mkdirSync(claudeSkill("release-notes"), { recursive: true });
		writeFileSync(join(claudeSkill("release-notes"), "SKILL.md"), "mine\n");
		expect(() => setPluginEnabled("notes", true, env)).toThrow(/did not register/);
		expect(readFileSync(join(claudeSkill("release-notes"), "SKILL.md"), "utf8")).toBe("mine\n");
		expect(existsSync(codexSkill("release-notes"))).toBe(false);
		expect(readFileSync(resolveDgPaths({ env }).configTomlPath, "utf8")).toMatch(/enabled = false/);
	});

	test("unregistering leaves skills that other plugins or the user own", () => {
		approvedAndEnabled();
		mkdirSync(claudeSkill("mine"), { recursive: true });
		writeFileSync(join(claudeSkill("mine"), "SKILL.md"), "mine\n");
		setPluginEnabled("notes", false, env);
		expect(readFileSync(join(claudeSkill("mine"), "SKILL.md"), "utf8")).toBe("mine\n");
	});

	test("uses HOME/.claude and HOME/.codex when the host variables are unset", () => {
		const home = join(root, "home");
		const bare = { DG_HOME: env.DG_HOME, HOME: home, DG_PATH_FENCE: root };
		addPlugin({ source: skillRepo("notes") }, bare);
		verifyPlugin("notes", { approve: true }, bare);
		setPluginEnabled("notes", true, bare);
		expect(existsSync(join(home, ".claude", "skills", "release-notes", "SKILL.md"))).toBe(true);
		expect(existsSync(join(home, ".codex", "skills", "release-notes", "SKILL.md"))).toBe(true);
	});

});
