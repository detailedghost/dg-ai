import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./test-support";

const SKILLS_DIR = join(REPO_ROOT, "plugins", "dg", "skills");
const HEADERS = ["Flag", "Short", "Effect", "Default"];
const FLAG = /(?<![\w-])(--[a-z][a-z-]*|-[A-Za-z])(?![\w-])/g;

const SKILLS = readdirSync(SKILLS_DIR)
	.filter((entry) => statSync(join(SKILLS_DIR, entry)).isDirectory())
	.filter((entry) => existsSync(join(SKILLS_DIR, entry, "SKILL.md")))
	.sort();

function usageLine(text: string): string | undefined {
	return text.split("\n").find((line) => line.startsWith("**Usage:**"));
}

function flagsSection(text: string): string[] | undefined {
	const lines = text.split("\n");
	const start = lines.findIndex((line) => line === "## Flags");
	if (start === -1) return undefined;
	const end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
	return lines.slice(start + 1, end === -1 ? undefined : end);
}

function cells(row: string): string[] {
	return row
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split(/(?<!\\)\|/)
		.map((cell) => cell.trim());
}

describe("packaged skills document their flags", () => {
	for (const skill of SKILLS) {
		const text = readFileSync(join(SKILLS_DIR, skill, "SKILL.md"), "utf8");
		const usage = usageLine(text);
		const section = flagsSection(text);
		if (!usage && !section) continue;

		test(`${skill} has a four-column Flags table covering its Usage flags`, () => {
			const usageFlags = [...(usage ?? "").matchAll(FLAG)].map((m) => m[1]);
			if (!section) {
				expect(usageFlags).toEqual([]);
				return;
			}
			const rows = section.filter((line) => line.startsWith("|"));
			expect(cells(rows[0] ?? "")).toEqual(HEADERS);
			const body = rows.slice(2).flatMap((row) => cells(row).slice(0, 2));
			const documented = new Set(
				body.flatMap((cell) => [...cell.matchAll(FLAG)].map((m) => m[1])),
			);
			const missing = usageFlags.filter((flag) => !documented.has(flag));
			expect(missing).toEqual([]);
		});
	}
});
