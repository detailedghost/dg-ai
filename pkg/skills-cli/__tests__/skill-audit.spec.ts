import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approxTokens, audit, backReferencedHeadings, brokenLinks, isPipelineShaped } from "../src/skill-audit/audit";
import { main } from "../src/skill-audit";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "skill-audit-test-"));
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

function makeSkill(name: string, files: Record<string, string> = {}): string {
	const dir = join(tmp, name);
	mkdirSync(dir, { recursive: true });
	for (const [rel, content] of Object.entries(files)) {
		const full = join(dir, rel);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
	return dir;
}

function expectedTokens(content: string): number {
	return approxTokens(Buffer.byteLength(content, "utf8"));
}

describe("audit", () => {
	test("returns null for a nonexistent directory", () => {
		expect(audit(join(tmp, "missing"))).toBeNull();
	});

	test("returns null for a dir with no .md files and no junk", () => {
		const dir = makeSkill("empty-skill", { "README.txt": "hi" });
		expect(audit(dir)).toBeNull();
	});

	test("flags a lowercase skill.md and reports total tokens", () => {
		const content = "---\ndescription: x\n---\n# hi\n";
		const dir = makeSkill("lower-skill", { "skill.md": content });
		const result = audit(dir);
		expect(result?.issues).toContain("top-level skill.md is lowercase — not discoverable; rename to SKILL.md");
		expect(result?.totalTokens).toBe(expectedTokens(content));
	});

	test("--fix renames skill.md to SKILL.md on disk", () => {
		const content = "# hi\n";
		const dir = makeSkill("lower-fix", { "skill.md": content });
		const result = audit(dir, 1500, true);
		expect(result?.fixed).toEqual(["renamed skill.md → SKILL.md"]);
		expect(existsSync(join(dir, "SKILL.md"))).toBe(true);
		expect(existsSync(join(dir, "skill.md"))).toBe(false);
	});

	test("flags junk files and --fix deletes them", () => {
		const dir = makeSkill("junk-skill", {
			"SKILL.md": "# hi\n",
			"notes.md:Zone.Identifier": "x",
		});
		const dry = audit(dir);
		expect(dry?.issues.some((i) => i.includes("junk file"))).toBe(true);
		expect(existsSync(join(dir, "notes.md:Zone.Identifier"))).toBe(true);

		const fixed = audit(dir, 1500, true);
		expect(fixed?.fixed.some((f) => f.startsWith("deleted"))).toBe(true);
		expect(existsSync(join(dir, "notes.md:Zone.Identifier"))).toBe(false);
	});

	test("marks ATTRIBUTION.md skills as vendor", () => {
		const dir = makeSkill("vendor-skill", { "SKILL.md": "# hi\n", "ATTRIBUTION.md": "upstream" });
		expect(audit(dir)?.vendor).toBe(true);
	});

	test("flags an entry point over the threshold", () => {
		const big = `---\ndescription: x\n---\n# hi\n${"word ".repeat(2000)}`;
		const dir = makeSkill("big-skill", { "SKILL.md": big });
		const result = audit(dir, 100);
		expect(result?.issues.some((i) => i.includes("exceeds 100"))).toBe(true);
	});

	test("flags a broken relative .md link", () => {
		const dir = makeSkill("link-skill", { "SKILL.md": "# hi\n\n[ref](references/missing.md)\n" });
		const result = audit(dir);
		expect(result?.issues).toContain("broken link: SKILL.md → references/missing.md");
	});

	test("flags an oversized frontmatter description", () => {
		const dir = makeSkill("desc-skill", { "SKILL.md": `---\ndescription: ${"x".repeat(600)}\n---\n# hi\n` });
		const result = audit(dir);
		expect(result?.issues.some((i) => i.includes("frontmatter description"))).toBe(true);
	});
});

describe("brokenLinks", () => {
	test("ignores links inside fenced code blocks", () => {
		const content = "# hi\n\n```\n[ref](missing.md)\n```\n";
		const dir = makeSkill("fence-skill", { "SKILL.md": content });
		const files = [{ path: "SKILL.md", tokens: 0, isEntryPoint: true }];
		expect(brokenLinks(dir, files)).toEqual([]);
	});
});

describe("isPipelineShaped / backReferencedHeadings", () => {
	test("detects a numbered Steps section", () => {
		expect(isPipelineShaped("## Steps\n\n1. do a\n2. do b\n")).toBe(true);
		expect(isPipelineShaped("## Notes\n\n1. do a\n")).toBe(false);
	});

	test("flags a heading referenced elsewhere via above/below", () => {
		const text = "## Dimensions\n\nsome text\n\n## Rules\n\nsee the Dimensions above\n";
		expect(backReferencedHeadings(text)).toContain("Dimensions");
	});
});

describe("main (CLI)", () => {
	test("requires at least one explicit target", () => {
		const code = main([]);
		expect(code).toBe(2);
	});

	test("expands a skills root into its child skill directories", () => {
		const root = join(tmp, "skills-root");
		makeSkill("skills-root/a", { "SKILL.md": "# a\n" });
		makeSkill("skills-root/b", { "skill.md": "# b\n" });
		const code = main([root, "--json"]);
		expect(code).toBe(1);
	});

	test("--json emits a machine-readable report with the chosen threshold", () => {
		const dir = makeSkill("json-skill", { "SKILL.md": "# hi\n" });
		const logs: string[] = [];
		const orig = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: string) => {
			logs.push(chunk);
			return true;
		}) as typeof process.stdout.write;
		try {
			main([dir, "--threshold", "10", "--json"]);
		} finally {
			process.stdout.write = orig;
		}
		const report = JSON.parse(logs.join(""));
		expect(report.threshold).toBe(10);
		expect(report.results[0].skill).toBe("json-skill");
	});

	test("exits 0 when every target is clean", () => {
		const dir = makeSkill("clean-skill", { "SKILL.md": "# hi\n" });
		expect(main([dir, "--json"])).toBe(0);
	});
});
