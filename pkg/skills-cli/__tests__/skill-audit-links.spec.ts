import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brokenLinks, type FileEntry } from "../src/skill/audit";

let tmp: string;
let skillRoot: string;

beforeAll(() => {
	tmp = mkdtempSync(join(tmpdir(), "skill-audit-links-test-"));
	skillRoot = join(tmp, "my-skill");
	mkdirSync(join(skillRoot, "references"), { recursive: true });
	mkdirSync(join(skillRoot, "notes"), { recursive: true });
	writeFileSync(join(skillRoot, "references/real.md"), "# Real");
	writeFileSync(join(skillRoot, "references/topic.md"), "# Topic");
	writeFileSync(join(skillRoot, "notes/note.md"), "# Note");
	mkdirSync(join(tmp, "other-skill"), { recursive: true });
	writeFileSync(join(tmp, "other-skill/SKILL.md"), "# Other");
});

afterAll(() => {
	rmSync(tmp, { recursive: true, force: true });
});

/** Write content to skillRoot/SKILL.md and return its FileEntry. */
function skill(content: string): FileEntry {
	writeFileSync(join(skillRoot, "SKILL.md"), content);
	return { path: "SKILL.md", tokens: 1, isEntryPoint: true };
}

/** Write content to an arbitrary path under skillRoot and return its FileEntry. */
function refFile(relPath: string, content: string): FileEntry {
	writeFileSync(join(skillRoot, relPath), content);
	return { path: relPath, tokens: 1, isEntryPoint: false };
}

describe("brokenLinks — tilde fences", () => {
	test("link inside ~~~ fence — suppressed, not reported", () => {
		const content = "~~~\n[bad](references/missing.md)\n~~~";
		expect(brokenLinks(skillRoot, [skill(content)])).toEqual([]);
	});
});

describe("brokenLinks — empty display text", () => {
	test("empty display text with broken href — reported", () => {
		expect(brokenLinks(skillRoot, [skill("[](references/missing.md)")])).toEqual(["SKILL.md → references/missing.md"]);
	});

	test("empty display text with valid href — no issue", () => {
		expect(brokenLinks(skillRoot, [skill("[](references/real.md)")])).toEqual([]);
	});
});

describe("brokenLinks — space in href", () => {
	test("link with space in href is silently skipped — not reported", () => {
		expect(brokenLinks(skillRoot, [skill("[text](references/my file.md)")])).toEqual([]);
	});
});

describe("brokenLinks — multiple files", () => {
	test("only the file with the broken link is reported", () => {
		const fileA = skill("[ok](references/real.md)");
		const fileB = refFile("notes/note.md", "[bad](references/missing.md)");
		writeFileSync(join(skillRoot, fileA.path), "[ok](references/real.md)");
		const results = brokenLinks(skillRoot, [fileA, fileB]);
		expect(results).toEqual(["notes/note.md → references/missing.md"]);
	});
});

describe("brokenLinks — cross-file dedup", () => {
	test("same broken href in two files produces two report entries", () => {
		const fileA = skill("[bad](references/missing.md)");
		const fileB = refFile("references/real.md", "[bad](references/missing.md)");
		const results = brokenLinks(skillRoot, [fileA, fileB]);
		expect(results).toEqual(["SKILL.md → references/missing.md", "references/real.md → references/missing.md"]);
	});
});

describe("brokenLinks — reference file contains broken link", () => {
	test("broken link inside references/topic.md is reported", () => {
		const entry = refFile("references/topic.md", "[bad](references/missing.md)");
		expect(brokenLinks(skillRoot, [entry])).toEqual(["references/topic.md → references/missing.md"]);
	});
});

describe("brokenLinks — bracket inside link text", () => {
	test("closing bracket in display text causes the link to be skipped", () => {
		const content = "[text with ] in it](references/real.md)";
		expect(brokenLinks(skillRoot, [skill(content)])).toEqual([]);
	});
});

describe("brokenLinks — consecutive links on same line", () => {
	test("valid and broken link on same line — only broken is reported", () => {
		const content = "[a](references/real.md) and [b](references/missing.md)";
		expect(brokenLinks(skillRoot, [skill(content)])).toEqual(["SKILL.md → references/missing.md"]);
	});

	test("two broken links on same line — both reported (distinct hrefs)", () => {
		const content = "[a](references/gone1.md) and [b](references/gone2.md)";
		expect(brokenLinks(skillRoot, [skill(content)])).toEqual([
			"SKILL.md → references/gone1.md",
			"SKILL.md → references/gone2.md",
		]);
	});
});

describe("brokenLinks — link after inline code", () => {
	test("inline code consumed first, following broken link still detected", () => {
		const content = "`code`[text](references/missing.md)";
		expect(brokenLinks(skillRoot, [skill(content)])).toEqual(["SKILL.md → references/missing.md"]);
	});

	test("inline code consumed first, following valid link passes", () => {
		const content = "`code`[text](references/real.md)";
		expect(brokenLinks(skillRoot, [skill(content)])).toEqual([]);
	});
});

describe("brokenLinks — nested/early-close fenced blocks", () => {
	test("non-greedy fence closes at first triple-backtick; link after reopened fence IS checked", () => {
		const content = "```\nfirst [safe](references/missing.md)\n```\n[bad](references/missing.md)\n```\n";
		const results = brokenLinks(skillRoot, [skill(content)]);
		expect(results).toEqual(["SKILL.md → references/missing.md"]);
	});
});

describe("brokenLinks — CRLF line endings", () => {
	test("broken link with CRLF line endings is detected", () => {
		const content = "[text](references/missing.md)\r\n[other](references/real.md)";
		expect(brokenLinks(skillRoot, [skill(content)])).toEqual(["SKILL.md → references/missing.md"]);
	});

	test("valid link with CRLF line endings — no issue", () => {
		const content = "[a](references/real.md)\r\n[b](references/topic.md)";
		expect(brokenLinks(skillRoot, [skill(content)])).toEqual([]);
	});
});

describe("brokenLinks — per-file seen set", () => {
	test("dedup suppresses second occurrence within same file", () => {
		const content = "[a](references/gone.md)\n[b](references/gone.md)";
		expect(brokenLinks(skillRoot, [skill(content)])).toEqual(["SKILL.md → references/gone.md"]);
	});

	test("same href broken in file A and file B yields two entries, not one", () => {
		const fileA = skill("[dup](references/nowhere.md)");
		const fileB = refFile("notes/note.md", "[dup](references/nowhere.md)");
		const results = brokenLinks(skillRoot, [fileA, fileB]);
		expect(results).toHaveLength(2);
		expect(results[0]).toBe("SKILL.md → references/nowhere.md");
		expect(results[1]).toBe("notes/note.md → references/nowhere.md");
	});
});
