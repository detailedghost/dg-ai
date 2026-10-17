import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { filesToInstall, skillDirectoryNames } from "../src/skill-files";

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
			filesToInstall(["zebra/SKILL.md", "alpha/note.md", "alpha/SKILL.md"]),
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
		const expected = readdirSync(root, { withFileTypes: true })
			.filter(
				(entry) =>
					entry.isDirectory() && existsSync(join(root, entry.name, "SKILL.md")),
			)
			.flatMap((entry) =>
				walk(join(root, entry.name)).map((file) => `${entry.name}/${file}`),
			)
			.sort();
		const tree = walk(root);
		const selected = filesToInstall(tree);
		expect(selected).toEqual(expected);
		expect(tree).toContain("README.md");
		expect(selected).not.toContain("README.md");
	});
});
