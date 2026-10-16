import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { filesToInstall, skillDirectoryNames } from "../src/skill-files";

/** Instruction files a skills-only install of this repo writes. README.md is not one of them. */
const REPO_SKILL_FILES = [
	"browser/SKILL.md",
	"browser/references/install.md",
	"channel-review/SKILL.md",
	"channel-review/references/commands.md",
	"channel-review/references/config.example.json",
	"channel-review/references/relay-setup.md",
	"channel-review/references/setup.md",
	"chat/SKILL.md",
	"demo/SKILL.md",
	"demo/references/authoring.md",
	"google-sms-cleanup/SKILL.md",
	"inbox-cleanup/SKILL.md",
	"inbox-cleanup/references/providers.md",
	"inbox-cleanup/references/workflow.md",
	"overwatch/SKILL.md",
	"proto/SKILL.md",
	"proto/agents/openai.yaml",
	"proto/references/commands.md",
	"proto/references/contracts.md",
];

function walk(root: string): string[] {
	const files: string[] = [];
	const visit = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const abs = join(dir, name);
			if (statSync(abs).isDirectory()) visit(abs);
			else files.push(relative(root, abs).split(sep).join("/"));
		}
	};
	visit(root);
	return files;
}

describe("skillDirectoryNames", () => {
	test("names only an immediate directory whose file is SKILL.md", () => {
		expect(
			skillDirectoryNames([
				"google-sms-cleanup/SKILL.md",
				"browser/SKILL.md",
				"browser/references/install.md",
				"nested/deeper/SKILL.md",
				"README.md",
				"/abs/SKILL.md",
			]),
		).toEqual(["browser", "google-sms-cleanup"]);
	});
});

describe("filesToInstall", () => {
	test("keeps every file under a skill directory, including references", () => {
		expect(
			filesToInstall([
				"README.md",
				"loose/notes.md",
				"browser/SKILL.md",
				"browser/references/install.md",
				"google-sms-cleanup/SKILL.md",
				"nested/deeper/SKILL.md",
				"nested/deeper/note.md",
			]),
		).toEqual([
			"browser/SKILL.md",
			"browser/references/install.md",
			"google-sms-cleanup/SKILL.md",
		]);
	});

	test("returns paths in sorted order", () => {
		expect(
			filesToInstall([
				"zebra/SKILL.md",
				"alpha/note.md",
				"alpha/SKILL.md",
			]),
		).toEqual(["alpha/SKILL.md", "alpha/note.md", "zebra/SKILL.md"]);
	});

	test("drops duplicates, dot segments, and parent traversal", () => {
		expect(
			filesToInstall([
				"ok/SKILL.md",
				"ok/SKILL.md",
				"ok",
				"ok/../../etc/passwd",
				"ok/./note.md",
				"ok//blank.md",
				"ok/foo\\bar.md",
				"/ok/secret",
				"ok\\secret.md",
			]),
		).toEqual(["ok/SKILL.md"]);
	});

	test("matches the repository skill tree exactly", () => {
		let dir = import.meta.dir;
		let root = "";
		for (let i = 0; i < 10; i++) {
			const candidate = join(dir, "plugins", "dg", "skills");
			if (existsSync(join(candidate, "google-sms-cleanup", "SKILL.md"))) {
				root = candidate;
				break;
			}
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
		expect(root).not.toBe("");
		expect(filesToInstall(walk(root))).toEqual(REPO_SKILL_FILES);
		expect(walk(root)).toContain("README.md");
	});
});
