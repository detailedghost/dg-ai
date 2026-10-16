import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test("finds thrash in a real nested plugin directory", () => {
	const home = join(root, "home");
	plant(join(home, ".claude", "plugins", "cache", "dg"));
	expect(thrashInstalled("claude", home, realSkillFs)).toBe(true);
});

test("does not follow a symlinked directory under the plugins tree", () => {
	const home = join(root, "home");
	const outside = join(root, "outside");
	plant(outside);
	mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
	symlinkSync(outside, join(home, ".claude", "plugins", "linked"));
	expect(thrashInstalled("claude", home, realSkillFs)).toBe(false);
});

test("returns false when the home directory has no plugin tree", () => {
	expect(thrashInstalled("claude", join(root, "missing"), realSkillFs)).toBe(false);
});

test("requires SKILL.md and does not treat the thrash directory itself as the skill", () => {
	const home = join(root, "home");
	mkdirSync(join(home, ".claude", "skills", "thrash"), { recursive: true });
	expect(thrashInstalled("claude", home, realSkillFs)).toBe(false);
});

test("finds a nested plugin skill at the walk limit and not one level past it", () => {
	const home = join(root, "home");
	const plugins = join(home, ".claude", "plugins");
	plant(join(plugins, "a", "b", "c", "d", "e", "f"));
	expect(thrashInstalled("claude", home, realSkillFs)).toBe(true);
	rmSync(join(plugins, "a"), { recursive: true, force: true });
	plant(join(plugins, "a", "b", "c", "d", "e", "f", "g"));
	expect(thrashInstalled("claude", home, realSkillFs)).toBe(false);
});

test.each(["node_modules", ".git", "skills"])(
	"does not walk a %s directory under plugins",
	(name) => {
		const home = join(root, "home");
		plant(join(home, ".claude", "plugins", name, "pkg"));
		expect(thrashInstalled("claude", home, realSkillFs)).toBe(false);
	},
);
