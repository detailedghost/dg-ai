import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { brokenLinks, type FileEntry } from "../src/skill/audit";

let tmp: string;
let skillRoot: string;

beforeAll(() => {
	tmp = mkdtempSync(join(tmpdir(), "skill-audit-test-"));
	skillRoot = join(tmp, "my-skill");
	mkdirSync(join(skillRoot, "references"), { recursive: true });
	writeFileSync(join(skillRoot, "references/real.md"), "# Real");
	mkdirSync(join(tmp, "other-skill"), { recursive: true });
	writeFileSync(join(tmp, "other-skill/SKILL.md"), "# Other");
});

afterAll(() => {
	rmSync(tmp, { recursive: true, force: true });
});

function skill(content: string): FileEntry {
	writeFileSync(join(skillRoot, "SKILL.md"), content);
	return { path: "SKILL.md", tokens: 1, isEntryPoint: true };
}

test("valid relative link — no issue", () => {
	expect(brokenLinks(skillRoot, [skill("[text](references/real.md)")])).toEqual([]);
});

test("broken relative link — reported", () => {
	expect(brokenLinks(skillRoot, [skill("[text](references/missing.md)")])).toEqual([
		"SKILL.md → references/missing.md",
	]);
});

test("link inside fenced code block — no issue", () => {
	expect(brokenLinks(skillRoot, [skill('```json\n{ "dest": "references/missing.md" }\n```')])).toEqual([]);
});

test("link inside inline code span — no issue", () => {
	expect(brokenLinks(skillRoot, [skill("`references/missing.md`")])).toEqual([]);
});

test("external http link — no issue", () => {
	expect(brokenLinks(skillRoot, [skill("[text](https://example.com/foo.md)")])).toEqual([]);
});

test("home-relative ~ link — no issue", () => {
	expect(brokenLinks(skillRoot, [skill("[text](~/.claude/foo.md)")])).toEqual([]);
});

test("bare filename without path separator — no issue", () => {
	expect(brokenLinks(skillRoot, [skill("[text](SKILL.md)")])).toEqual([]);
});

test("link with fragment — resolves base, no issue", () => {
	expect(brokenLinks(skillRoot, [skill("[text](references/real.md#section)")])).toEqual([]);
});

test("cross-skill relative link — resolves via parent, no issue", () => {
	expect(brokenLinks(skillRoot, [skill("[text](../other-skill/SKILL.md)")])).toEqual([]);
});

test("URL display text with path-like label — no issue (href is http)", () => {
	expect(brokenLinks(skillRoot, [skill("[mattpocock/skills/foo.md](https://github.com/mattpocock/foo)")])).toEqual([]);
});

test("bare template var path in prose — no issue (not a markdown link)", () => {
	expect(brokenLinks(skillRoot, [skill("See LIGHT_DIR/references/domain.md for details.")])).toEqual([]);
});

test("JSON key in fenced block — no issue", () => {
	expect(
		brokenLinks(skillRoot, [skill('See protocol.md.\n\n```json\n{ "slug": "x", "dest": "references/topic.md" }\n```')]),
	).toEqual([]);
});

test("deduplicates repeated broken links in same file", () => {
	const content = "[a](references/missing.md)\n[b](references/missing.md)";
	expect(brokenLinks(skillRoot, [skill(content)])).toEqual(["SKILL.md → references/missing.md"]);
});
