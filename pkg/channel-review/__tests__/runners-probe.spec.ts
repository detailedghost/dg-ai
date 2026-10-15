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
