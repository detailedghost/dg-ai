import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	frontmatter,
	GATE_COMMAND,
	LOCAL_DEFAULT,
	REPO_ROOT,
} from "./test-support";

const REQUIRES_LINE = /^requires:/m;

function description(text: string): string {
	const lines = frontmatter(text).split("\n");
	const start = lines.findIndex((line) => line.startsWith("description:"));
	if (start === -1) return "";
	const rest = lines.slice(start + 1);
	const end = rest.findIndex((line) => /^\S/.test(line));
	const body = end === -1 ? rest : rest.slice(0, end);
	return [lines[start].slice("description:".length), ...body].join(" ").trim();
}

function flagsRows(text: string): string[][] {
	const lines = text.split("\n");
	const start = lines.findIndex((line) => line === "## Flags");
	if (start === -1) return [];
	const end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
	return lines
		.slice(start + 1, end === -1 ? undefined : end)
		.filter((line) => line.startsWith("|"))
		.map((row) =>
			row
				.trim()
				.replace(/^\||\|$/g, "")
				.split(/(?<!\\)\|/)
				.map((cell) => cell.trim()),
		);
}

export function describeLocalPageSkill(skill: string, followUp: string): void {
	const skillDir = join(REPO_ROOT, "plugins", "dg", "skills", skill);
	const text = readFileSync(join(skillDir, "SKILL.md"), "utf8");

	describe(`${skill}/SKILL.md local-page contract`, () => {
		test("declares no requires line in the frontmatter", () => {
			expect(REQUIRES_LINE.test(frontmatter(text))).toBe(false);
		});

		test("the description names the local page before any extension mention", () => {
			const desc = description(text);
			const local = desc.search(/\blocal\b/i);
			const ext = desc.search(/--ext|extension/i);
			expect(local).toBeGreaterThanOrEqual(0);
			expect(ext).toBeGreaterThanOrEqual(0);
			expect(local).toBeLessThan(ext);
		});

		test("the Flags table has an --ext row whose Default says local is the default", () => {
			const row = flagsRows(text).find((cells) => cells[0]?.includes("--ext"));
			expect(row).toBeDefined();
			expect(row?.[3] ?? "").toMatch(LOCAL_DEFAULT);
		});

		test("every require-extension gate line carries --ext and at least one exists", () => {
			const gates = text.split("\n").filter((line) => GATE_COMMAND.test(line));
			expect(gates.length).toBeGreaterThan(0);
			for (const line of gates) expect(line).toContain("--ext");
		});

		test("the --ext section gates with require-extension and then runs the --ext follow-up", () => {
			const lines = text.split("\n");
			const gate = lines.findIndex(
				(line) =>
					line.includes(`--ext only: dg-skills require-extension ${skill}`) &&
					line.includes("|| exit 1"),
			);
			expect(gate).toBeGreaterThanOrEqual(0);
			const next = lines.slice(gate + 1).find((line) => line.trim() !== "");
			expect(next ?? "").toContain(followUp);
		});

		test("the --ext section is exactly the gate line and the follow-up command", () => {
			const lines = text.split("\n");
			const gate = lines.findIndex((line) =>
				line.includes(`--ext only: dg-skills require-extension ${skill}`),
			);
			expect(gate).toBeGreaterThan(0);
			expect(lines[gate - 1]).toMatch(/^```/);
			expect(lines[gate + 1].trim()).toBe(followUp);
			expect(lines[gate + 2]).toMatch(/^```/);
		});

		test("the bootstrap block keeps the dg-agent gate", () => {
			expect(text).toMatch(/^dg-agent --version >\/dev\/null 2>&1 \|\|\n {2}"\$HOME\/\.local\/bin\/dg-agent" --version/m);
		});

		test("the extension-specific notes live in references/extension.md", () => {
			const reference = join(skillDir, "references", "extension.md");
			expect(existsSync(reference)).toBe(true);
			const body = readFileSync(reference, "utf8");
			expect(body).toMatch(/--ext/);
			expect(body).toMatch(/mirrored/i);
		});
	});
}
