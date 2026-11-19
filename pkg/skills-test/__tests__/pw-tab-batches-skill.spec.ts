import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { REPO_ROOT, readRepoFile } from "./test-support";

const SKILLS = join(REPO_ROOT, "plugins", "dg", "skills");
const SKILL = readRepoFile("plugins", "dg", "skills", "pw", "SKILL.md");
const TABS_PATH = join(SKILLS, "pw", "references", "tabs.md");
const OLD_NAMES = /dg:browser|dg-skills (batch-open|launch)\b/;

function section(heading: string): string {
	const lines = SKILL.split("\n");
	const start = lines.findIndex((line) => line.trimEnd() === heading);
	if (start === -1) return "";
	const end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
	return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

function markdownFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) return markdownFiles(full);
		return name.endsWith(".md") ? [full] : [];
	});
}

describe("pw tab batches replace the browser skill", () => {
	test("plugins/dg/skills has no browser skill", () => {
		expect(existsSync(join(SKILLS, "browser"))).toBe(false);
	});

	test("the skills index lists no browser skill", () => {
		expect(readRepoFile("plugins", "dg", "skills", "README.md")).not.toMatch(/\bbrowser\/SKILL\.md|\[`?browser`?\]/);
	});

	test("pw SKILL.md has a Tab batches section with both verbs and a pointer to references/tabs.md", () => {
		const tabs = section("## Tab batches");
		expect(tabs).toContain("pw batch-open [--ext] [-g <name>]");
		expect(tabs).toContain("pw --ext launch");
		expect(tabs).toContain("references/tabs.md");
	});

	test("pw SKILL.md routes the tab batch need to references/tabs.md", () => {
		expect(section("## References")).toMatch(/\|[^|\n]*[Tt]ab batch[^|\n]*\|\s*`references\/tabs\.md`\s*\|/);
	});

	test("references/tabs.md covers refs, markers, group color, Load unpacked and every OS folder", () => {
		const tabs = readFileSync(TABS_PATH, "utf8");
		for (const needle of [
			"Without `--ext`, it opens plain tabs and needs no extension.",
			"`launch` always needs `--ext`.",
			"owner/repo#num",
			"alias#num",
			"#_tab_group=<name>",
			"Group color",
			"Load unpacked",
			"dg-skills install [chrome|firefox] [--local]",
			"%LOCALAPPDATA%\\dg\\dg-ai-extension-chrome",
			"~/.local/share/dg/dg-ai-extension-chrome",
			"~/Library/Application Support/dg/dg-ai-extension-chrome",
		])
			expect(tabs).toContain(needle);
	});

	test("no skill or user doc names the browser skill or the old top-level commands", () => {
		const files = [
			...markdownFiles(SKILLS),
			...markdownFiles(join(REPO_ROOT, "docs")).filter((file) => !file.startsWith(join(REPO_ROOT, "docs", "adr") + sep)),
			join(REPO_ROOT, "README.md"),
			join(REPO_ROOT, "pkg", "extension", "README.md"),
		];
		const offenders = files
			.filter((file) => OLD_NAMES.test(readFileSync(file, "utf8")))
			.map((file) => relative(REPO_ROOT, file));
		expect(offenders).toEqual([]);
	});
});
