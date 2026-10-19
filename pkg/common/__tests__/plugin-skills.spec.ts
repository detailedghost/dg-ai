import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudePluginSkillsDirs } from "../src/node/plugin-skills";

let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "plugin-skills-"));
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

function plant(marketplace: string, version: string): string {
	const dir = join(
		home,
		".claude",
		"plugins",
		"cache",
		marketplace,
		"dg",
		version,
		"plugins",
		"dg",
		"skills",
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

test("returns nothing when the home directory has no plugin cache", () => {
	expect(claudePluginSkillsDirs(home)).toEqual([]);
});

test("returns the skills directory of an installed dg plugin", () => {
	const dir = plant("detailedghost", "1.15.0");
	expect(claudePluginSkillsDirs(home)).toEqual([dir]);
});

test("picks the highest semver version, not the highest string", () => {
	plant("mkt", "1.9.0");
	const newest = plant("mkt", "1.15.0");
	plant("mkt", "1.10.2");
	expect(claudePluginSkillsDirs(home)).toEqual([newest]);
});

test("returns one directory per marketplace", () => {
	const a = plant("a", "1.0.0");
	const b = plant("b", "2.0.0");
	expect(claudePluginSkillsDirs(home).sort()).toEqual([a, b].sort());
});

test("ignores versions that are not semver", () => {
	plant("mkt", "latest");
	expect(claudePluginSkillsDirs(home)).toEqual([]);
});

test("ignores a plugin not named dg", () => {
	const dir = join(home, ".claude", "plugins", "cache", "mkt", "other", "1.0.0", "plugins", "dg", "skills");
	mkdirSync(dir, { recursive: true });
	expect(claudePluginSkillsDirs(home)).toEqual([]);
});

test("does not follow a symlinked marketplace directory", () => {
	const outside = join(home, "outside");
	mkdirSync(join(outside, "dg", "1.0.0", "plugins", "dg", "skills"), { recursive: true });
	const cache = join(home, ".claude", "plugins", "cache");
	mkdirSync(cache, { recursive: true });
	symlinkSync(outside, join(cache, "linked"));
	expect(claudePluginSkillsDirs(home)).toEqual([]);
});

test("skips a version whose skills directory is missing", () => {
	mkdirSync(join(home, ".claude", "plugins", "cache", "mkt", "dg", "1.0.0"), { recursive: true });
	expect(claudePluginSkillsDirs(home)).toEqual([]);
});
