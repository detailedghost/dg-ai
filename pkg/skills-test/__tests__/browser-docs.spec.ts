import { describe, expect, test } from "bun:test";
import { PW_MODES } from "@dg/common/node";
import { LOCAL_ONLY_VERBS } from "../../skills-cli/src/pw/browser-mode";
import { readRepoFile } from "./test-support";

const CONFIG = readRepoFile("docs", "config.md");
const PW = readRepoFile("docs", "pw.md");
const SKILL_MODE = readRepoFile("plugins", "dg", "skills", "pw", "references", "browser-mode.md");

const row = (doc: string, key: string): string =>
	doc.split("\n").find((line) => line.startsWith(`| \`${key}\``)) ?? "";

const rowFor = (doc: string, verb: string): string[] =>
	doc
		.split("\n")
		.filter((line) => line.startsWith("|") && line.includes(`\`${verb}\``))
		.map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
		.find((cells) => (cells[0] ?? "").split(",").some((name) => name.trim() === `\`${verb}\``)) ?? [];

describe("browser mode docs", () => {
	test("docs/config.md lists pw.mode with ext, local and auto", () => {
		const line = row(CONFIG, "pw.mode");
		expect(line).not.toBe("");
		for (const mode of PW_MODES) expect([mode, line.includes(`\`${mode}\``)]).toEqual([mode, true]);
	});

	test("docs/config.md lists pw.phi_sites and plugins fail_closed", () => {
		expect(row(CONFIG, "pw.phi_sites")).toContain("https://");
		expect(row(CONFIG, "plugins.<name>.fail_closed")).toContain("false");
	});

	test("docs name DG_BROWSER as a path and DG_PW_MODE as the mode", () => {
		for (const doc of [PW, SKILL_MODE]) {
			expect(doc).toContain("DG_PW_MODE");
			expect(doc).not.toMatch(/DG_BROWSER=(ext|local|auto)/);
		}
	});

	test("docs/pw.md and the pw skill give a reason for every local-only verb", () => {
		for (const doc of [PW, SKILL_MODE]) {
			for (const verb of LOCAL_ONLY_VERBS) {
				const cells = rowFor(doc, verb);
				expect([verb, cells.length]).toEqual([verb, 2]);
				expect([verb, (cells[1] ?? "").length > 20]).toEqual([verb, true]);
			}
		}
	});

	test("docs/pw.md names the flags, DG_PW_MODE, DG_BROWSER, pw.mode and pw.phi_sites", () => {
		for (const term of ["--ext", "--local", "DG_PW_MODE", "DG_BROWSER", "pw.mode", "pw.phi_sites", "agent window", "PHI"])
			expect([term, PW.includes(term)]).toEqual([term, true]);
	});
});
