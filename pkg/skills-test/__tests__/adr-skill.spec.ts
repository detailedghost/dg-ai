import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { LEVELS, gradeLimit, type Level } from "../../skills-cli/src/adr/levels";
import { HUMAN_SECTIONS } from "../../skills-cli/src/adr/templates";
import { REPO_ROOT, readRepoFile } from "./test-support";

const SKILLS_DIR = join(REPO_ROOT, "plugins", "dg", "skills");

function filesUnder(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const path = join(dir, entry);
		return statSync(path).isDirectory() ? filesUnder(path) : [path];
	});
}

function levelRows(): Map<string, string> {
	const rows = new Map<string, string>();
	const text = readRepoFile("plugins", "dg", "skills", "adr", "references", "levels.md");
	for (const line of text.split("\n")) {
		const cells = line.split("|").map((cell) => cell.trim());
		const name = /^`([a-z0-9-]+)`$/.exec(cells[1] ?? "")?.[1];
		if (name) rows.set(name, cells[2] ?? "");
	}
	return rows;
}

describe("adr skill levels table", () => {
	test("lists exactly the CLI levels", () => {
		expect([...levelRows().keys()].sort()).toEqual([...LEVELS].sort());
	});

	test("states each CLI grade limit", () => {
		const rows = levelRows();
		for (const level of LEVELS) {
			const limit = gradeLimit(level as Level);
			expect(rows.get(level)).toBe(limit === null ? "none" : String(limit));
		}
	});
});

describe("adr skill write template", () => {
	test("headings equal HUMAN_SECTIONS", () => {
		const text = readRepoFile("plugins", "dg", "skills", "adr", "references", "write-adr.md");
		const block = /````markdown\n([\s\S]*?)\n````/.exec(text)?.[1] ?? "";
		const headings = block
			.split("\n")
			.filter((line) => line.startsWith("## "))
			.map((line) => line.slice(3));
		expect(headings).toEqual([...HUMAN_SECTIONS]);
		expect(block).toContain("Topic:");
	});
});

describe("skill text names the paired record flow", () => {
	test("no skill file uses the adr-root either/or", () => {
		const hits = filesUnder(SKILLS_DIR).filter((path) =>
			readFileSync(path, "utf8").includes("<adr-root>"),
		);
		expect(hits).toEqual([]);
	});

	test("no skill file says decisions persist to .agents/decisions alone", () => {
		const pattern = /persist(?:s|ed)?[^\n.]*to `?\.agents\/decisions\/?`?(?![^\n]*docs\/adr)/i;
		const hits = filesUnder(SKILLS_DIR).filter((path) =>
			pattern.test(readFileSync(path, "utf8")),
		);
		expect(hits).toEqual([]);
	});
});
