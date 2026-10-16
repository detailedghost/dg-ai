import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { REPO_ROOT, readRepoFile } from "./test-support";

const skillRoot = join(REPO_ROOT, "plugins/dg/skills/google-sms-cleanup");

describe("google-sms-cleanup skill distribution", () => {
	test("both plugin hosts discover google-sms-cleanup through the canonical shared tree", () => {
		expect(existsSync(join(skillRoot, "SKILL.md"))).toBe(true);
		const claude = JSON.parse(readRepoFile(".claude-plugin", "plugin.json"));
		const codex = JSON.parse(
			readRepoFile("plugins/dg/.codex-plugin/plugin.json"),
		);
		expect(
			claude.skills.map((path: string) => resolve(REPO_ROOT, path)),
		).toContain(resolve(skillRoot, ".."));
		expect(resolve(REPO_ROOT, "plugins/dg", codex.skills)).toBe(
			resolve(skillRoot, ".."),
		);
		expect(claude.description).toBe(codex.description);
		expect(claude.description).toBe(codex.interface.longDescription);
		expect(claude.description).toMatch(/Google Messages/);
		expect(claude.keywords).toEqual(expect.arrayContaining(["sms", "messages"]));
		expect(codex.interface.defaultPrompt).toContain("Clean up Google Messages");
	});

	test("frontmatter carries only the kebab-case name and description", () => {
		const skill = readFileSync(join(skillRoot, "SKILL.md"), "utf8");
		const front = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? "";
		const keys = front
			.split("\n")
			.filter((line) => /^[a-z-]+:/.test(line))
			.map((line) => line.split(":")[0]);
		expect(keys).toEqual(["name", "description"]);
		expect(front).toMatch(/^name: google-sms-cleanup$/m);
		expect(skill).not.toContain("argument-hint:");
		expect(skill).not.toContain("user-invocable:");
		expect(skill).not.toMatch(/^requires:/m);
	});

	test("keeps the safety defaults, config block, and Messages for Web limits", () => {
		const skill = readFileSync(join(skillRoot, "SKILL.md"), "utf8");
		for (const line of [
			"allow_delete: false            # never delete conversations or messages",
			"allow_send: false              # never send; any outgoing text needs explicit per-message user approval",
			"flag_ambiguous: true           # list unsure items for the user instead of acting",
			"never_misclassify_as_spam: []  # senders the user confirmed legitimate",
		])
			expect(skill).toContain(line);
		expect(skill).toContain("Never touch compose.");
		expect(skill).toContain(
			"No starring, renaming groups, labels, or folders on the web; those are",
		);
		expect(skill).toContain("Block & report spam");
		expect(skill).toContain("Keep rules");
	});

	test("the skills README lists google-sms-cleanup after channel-review", () => {
		const readme = readRepoFile("plugins/dg/skills/README.md");
		expect(readme).toMatch(/^\| `google-sms-cleanup\/` \|/m);
		expect(readme).toMatch(/^ {2}google-sms-cleanup\/$/m);
		const names = readme
			.split("\n")
			.filter((line) => line.startsWith("| `"))
			.map((line) => /`([^`]+)`/.exec(line)?.[1]);
		expect(names.indexOf("google-sms-cleanup/")).toBe(
			names.indexOf("channel-review/") + 1,
		);
	});
});
