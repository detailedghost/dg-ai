import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./test-support";

const BROWSER_DIR = join(REPO_ROOT, "plugins", "dg", "skills", "browser");
const SKILL = readFileSync(join(BROWSER_DIR, "SKILL.md"), "utf8");
const FRONTMATTER = SKILL.split("---")[1] ?? "";
const DESCRIPTION = FRONTMATTER.split("\n").find((l) => l.startsWith("description:")) ?? "";
const LEAD = "Open PR or URL tabs in the default browser (local mode, the default)";

const EXPECTED_FLAGS: Record<string, string> = {
	"--ext": "none",
	"--group": "-g",
	"--repo": "none",
	"--print": "none",
	"--browser": "none",
	"--list": "none",
	"--dry-run": "none",
	"--local": "none",
	"--version": "none",
	"--video": "none",
};

function section(heading: string): string {
	const lines = SKILL.split("\n");
	const start = lines.findIndex((line) => line.startsWith(heading));
	if (start === -1) return "";
	const end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
	return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

function rows(): string[][] {
	return section("## Flags")
		.split("\n")
		.filter((line) => line.startsWith("|"))
		.slice(2)
		.map((row) =>
			row
				.trim()
				.replace(/^\||\|$/g, "")
				.split(/(?<!\\)\|/)
				.map((cell) => cell.trim().replace(/`/g, "")),
		);
}

describe("browser skill leads with local mode", () => {
	test("the frontmatter has no requires line", () => {
		expect(FRONTMATTER).not.toMatch(/^requires:/m);
	});

	test("the description leads with local mode and names --ext after it", () => {
		expect(DESCRIPTION.replace(/^description:\s*/, "")).toStartWith(LEAD);
		expect(DESCRIPTION.indexOf("local")).toBeGreaterThan(-1);
		expect(DESCRIPTION.indexOf("local")).toBeLessThan(DESCRIPTION.indexOf("--ext"));
	});

	test("the Flags table has four cells per row and a row for each flag", () => {
		const table = rows();
		for (const row of table) expect(row).toHaveLength(4);
		const byFlag = new Map(table.map((row) => [(row[0] ?? "").split(/\s/)[0], row]));
		for (const [flag, short] of Object.entries(EXPECTED_FLAGS)) {
			expect(byFlag.has(flag)).toBe(true);
			expect(byFlag.get(flag)?.[1]).toBe(short);
		}
	});

	test("the --ext row defaults to off with local as the default", () => {
		const row = rows().find((cells) => cells[0]?.startsWith("--ext"));
		expect(row?.[3]).toBe("off (local is the default)");
	});

	test("batch-open is documented as plain tabs by default", () => {
		const line = SKILL.split("\n").find((l) => l.includes("batch-open") && l.includes("plain tabs"));
		expect(line).toBeDefined();
	});

	test("launch and install are documented under --ext mode with a pointer to references/extension.md", () => {
		const ext = section("## --ext mode");
		expect(ext).toContain("launch");
		expect(ext).toContain("install");
		expect(ext).toContain("references/extension.md");
	});

	test("references/extension.md exists", () => {
		expect(existsSync(join(BROWSER_DIR, "references", "extension.md"))).toBe(true);
	});
});
