import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realSkillFs, thrashInstalled } from "../src/runners/probe";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "probe-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function plant(dir: string): void {
	mkdirSync(join(dir, "skills", "thrash"), { recursive: true });
	writeFileSync(join(dir, "skills", "thrash", "SKILL.md"), "x");
}

function plantPlugin(home: string, marketplace = "mkt", version = "1.0.0"): void {
	plant(join(home, ".claude", "plugins", "cache", marketplace, "dg", version));
}

test("finds thrash in the cached dg plugin", () => {
	const home = join(root, "home");
	plantPlugin(home);
	expect(thrashInstalled("claude", home, realSkillFs)).toBe(true);
});

test("does not follow a symlinked marketplace directory", () => {
	const home = join(root, "home");
	const outside = join(root, "outside");
	plant(join(outside, "dg", "1.0.0"));
	mkdirSync(join(home, ".claude", "plugins", "cache"), { recursive: true });
	symlinkSync(outside, join(home, ".claude", "plugins", "cache", "linked"));
	expect(thrashInstalled("claude", home, realSkillFs)).toBe(false);
});

test("returns false when the home directory has no plugin tree", () => {
	expect(thrashInstalled("claude", join(root, "missing"), realSkillFs)).toBe(false);
});

test("requires SKILL.md and does not treat the thrash directory itself as the skill", () => {
	const home = join(root, "home");
	mkdirSync(join(home, ".claude", "plugins", "cache", "mkt", "dg", "1.0.0", "skills", "thrash"), {
		recursive: true,
	});
	expect(thrashInstalled("claude", home, realSkillFs)).toBe(false);
});

test("reports not installed when thrash exists only under another plugin", () => {
	const home = join(root, "home");
	plant(join(home, ".claude", "plugins", "other"));
	expect(thrashInstalled("claude", home, realSkillFs)).toBe(false);
});

test("ignores a thrash skill in a plugin not named dg", () => {
	const home = join(root, "home");
	plant(join(home, ".claude", "plugins", "cache", "mkt", "other", "1.0.0"));
	expect(thrashInstalled("claude", home, realSkillFs)).toBe(false);
});

test("finds an installed plugin skill when no local skills directory exists", () => {
	const home = join(root, "home");
	plantPlugin(home, "mkt", "1.16.0");
	expect(existsSync(join(home, ".claude", "skills"))).toBe(false);
	expect(thrashInstalled("claude", home, realSkillFs)).toBe(true);
});

test("does not count a flat local ~/.claude/skills/thrash for claude", () => {
	const home = join(root, "home");
	plant(join(home, ".claude"));
	expect(thrashInstalled("claude", home, realSkillFs)).toBe(false);
});

test("copilot finds only ~/.copilot/skills and ignores ~/.claude/skills", () => {
	const claudeHome = join(root, "a");
	plant(join(claudeHome, ".claude"));
	expect(thrashInstalled("copilot", claudeHome, realSkillFs)).toBe(false);
	const copilotHome = join(root, "b");
	plant(join(copilotHome, ".copilot"));
	expect(thrashInstalled("copilot", copilotHome, realSkillFs)).toBe(true);
});

test.each([".codex", ".agents"])("codex finds thrash under %s/skills", (dir) => {
	const home = join(root, "home");
	plant(join(home, dir));
	expect(thrashInstalled("codex", home, realSkillFs)).toBe(true);
});

test("codex does not look inside the claude plugin tree", () => {
	const home = join(root, "home");
	plantPlugin(home);
	expect(thrashInstalled("codex", home, realSkillFs)).toBe(false);
});

test.each(["copilot", "codex"] as const)("%s ignores a plugin skill under the claude plugin tree", (runner) => {
	const home = join(root, "home");
	plantPlugin(home);
	expect(thrashInstalled(runner, home, realSkillFs)).toBe(false);
});
