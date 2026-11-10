import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approxTokens, audit, type FileEntry } from "../src/skill/audit";

type Audit = NonNullable<ReturnType<typeof audit>>;

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "skill-audit-test-audit-"));
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

/** Write a minimal valid skill dir and return its path. */
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

/** Build a SKILL.md with a frontmatter description of exactly `len` chars. */
function skillMdWithDesc(len: number): string {
	return `---\ndescription: ${"x".repeat(len)}\n---\n# skill\n`;
}

function expectedTokens(content: string): number {
	return approxTokens(Buffer.byteLength(content, "utf8"));
}

test("audit returns null for a nonexistent directory", () => {
	const result = audit(join(tmp, "does-not-exist"));
	expect(result).toBeNull();
});

test("audit returns null for a dir with no .md files and no junk", () => {
	const dir = makeSkill("empty-skill", { "README.txt": "hi" });
	expect(audit(dir)).toBeNull();
});

test("audit returns a result for a dir containing a single .md file", () => {
	const content = "# My Skill\nSome content.";
	const dir = makeSkill("my-skill", { "SKILL.md": content });
	const result = audit(dir) as Audit;
	expect(result).not.toBeNull();
	expect(result.skill).toBe("my-skill");
	expect(result.dir).toBe(dir);
	expect(result.issues).toEqual([]);
	expect(result.fixed).toEqual([]);
});

test("audit totalTokens is the sum of all file token counts", () => {
	const a = "# file one";
	const b = "# file two with more words";
	const dir = makeSkill("sum-skill", { "SKILL.md": a, "references/extra.md": b });
	const result = audit(dir) as Audit;
	expect(result.totalTokens).toBe(expectedTokens(a) + expectedTokens(b));
});

test("non-.md files are excluded from files[]", () => {
	const dir = makeSkill("mixed-skill", { "SKILL.md": "# x", "config.json": "{}", "script.sh": "#!/bin/sh" });
	const result = audit(dir) as Audit;
	const names = result.files.map((f: FileEntry) => f.path);
	expect(names).toContain("SKILL.md");
	expect(names).not.toContain("config.json");
	expect(names).not.toContain("script.sh");
});

test("SKILL.md at root sets isEntryPoint: true", () => {
	const dir = makeSkill("ep-skill", { "SKILL.md": "# x" });
	const result = audit(dir) as Audit;
	const ep = result.files.find((f: FileEntry) => f.path === "SKILL.md");
	expect(ep?.isEntryPoint).toBe(true);
});

test("a reference file is not an entry point", () => {
	const dir = makeSkill("ref-skill", { "SKILL.md": "# x", "references/guide.md": "# guide" });
	const result = audit(dir) as Audit;
	const ref = result.files.find((f: FileEntry) => f.path === "references/guide.md");
	expect(ref?.isEntryPoint).toBe(false);
});

test("SKILL.md inside references/ subdir gets isEntryPoint: true (filename-only check)", () => {
	const dir = makeSkill("nested-ep", { "SKILL.md": "# top", "references/SKILL.md": "# nested" });
	const result = audit(dir) as Audit;
	const nested = result.files.find((f: FileEntry) => f.path === "references/SKILL.md");
	expect(nested?.isEntryPoint).toBe(true);
});

test("node_modules directory is not walked", () => {
	const dir = makeSkill("skip-node", { "SKILL.md": "# x", "node_modules/dep/README.md": "# dep" });
	const result = audit(dir) as Audit;
	const paths = result.files.map((f: FileEntry) => f.path);
	expect(paths.every((p: string) => !p.startsWith("node_modules"))).toBe(true);
});

test(".git directory is not walked", () => {
	const dir = makeSkill("skip-git", { "SKILL.md": "# x", ".git/COMMIT_EDITMSG": "init" });
	const result = audit(dir) as Audit;
	const paths = result.files.map((f: FileEntry) => f.path);
	expect(paths.every((p: string) => !p.startsWith(".git"))).toBe(true);
});

test("examples directory is not walked", () => {
	const dir = makeSkill("skip-examples", { "SKILL.md": "# x", "examples/demo.md": "# demo" });
	const result = audit(dir) as Audit;
	const paths = result.files.map((f: FileEntry) => f.path);
	expect(paths.every((p: string) => !p.startsWith("examples"))).toBe(true);
});

test("lowercase skill.md reports an issue when doFix is false", () => {
	const dir = makeSkill("lower-skill", { "skill.md": "# x" });
	const result = audit(dir) as Audit;
	expect(result.issues.some((i: string) => i.includes("rename to SKILL.md"))).toBe(true);
	expect(result.fixed).toEqual([]);
});

test("lowercase skill.md issue message contains expected substring", () => {
	const dir = makeSkill("lower-msg", { "skill.md": "# x" });
	const result = audit(dir) as Audit;
	const issue = result.issues.find((i: string) => i.includes("skill.md"));
	expect(issue).toContain("lowercase");
});

test("--fix renames lowercase skill.md to SKILL.md and reports in fixed[]", () => {
	const dir = makeSkill("lower-fix", { "skill.md": "# x" });
	const result = audit(dir, 1500, true) as Audit;
	expect(result.fixed).toContain("renamed skill.md → SKILL.md");
	expect(result.issues).toEqual([]);
	expect(result.files.some((f: FileEntry) => f.path === "SKILL.md")).toBe(true);
	expect(result.files.some((f: FileEntry) => f.path === "skill.md")).toBe(false);
});

test("Zone.Identifier file is reported as junk", () => {
	const dir = makeSkill("junk-zone", { "SKILL.md": "# x", "file.Zone.Identifier": "" });
	const result = audit(dir) as Audit;
	expect(result.issues.some((i: string) => i.includes("junk file"))).toBe(true);
	expect(result.junk).toContain("file.Zone.Identifier");
});

test(".DS_Store file is reported as junk", () => {
	const dir = makeSkill("junk-ds", { "SKILL.md": "# x", ".DS_Store": "" });
	const result = audit(dir) as Audit;
	expect(result.junk).toContain(".DS_Store");
});

test("Thumbs.db file is reported as junk", () => {
	const dir = makeSkill("junk-thumbs", { "SKILL.md": "# x", "Thumbs.db": "" });
	const result = audit(dir) as Audit;
	expect(result.junk).toContain("Thumbs.db");
});

test("two junk files → both reported in issues and junk[]", () => {
	const dir = makeSkill("junk-two", { "SKILL.md": "# x", ".DS_Store": "", "Thumbs.db": "" });
	const result = audit(dir) as Audit;
	expect(result.junk).toHaveLength(2);
	expect(result.issues.filter((i: string) => i.startsWith("junk file"))).toHaveLength(2);
});

test("--fix deletes junk files and reports in fixed[]", () => {
	const dir = makeSkill("junk-fix", { "SKILL.md": "# x", ".DS_Store": "", "Thumbs.db": "" });
	const result = audit(dir, 1500, true) as Audit;
	expect(result.fixed).toContain("deleted .DS_Store");
	expect(result.fixed).toContain("deleted Thumbs.db");
	expect(result.issues).toEqual([]);
});

test("junk file with no .md files → audit returns a result (not null)", () => {
	const dir = makeSkill("junk-only", { ".DS_Store": "" });
	const result = audit(dir);
	expect(result).not.toBeNull();
});

test("ATTRIBUTION.md present → vendor: true", () => {
	const dir = makeSkill("vendor-skill", { "SKILL.md": "# x", "ATTRIBUTION.md": "# vendor" });
	const result = audit(dir) as Audit;
	expect(result.vendor).toBe(true);
});

test("no ATTRIBUTION.md → vendor: false", () => {
	const dir = makeSkill("own-skill", { "SKILL.md": "# x" });
	const result = audit(dir) as Audit;
	expect(result.vendor).toBe(false);
});

test("ATTRIBUTION.md appears in files[] (it is a .md file)", () => {
	const dir = makeSkill("vendor-files", { "SKILL.md": "# x", "ATTRIBUTION.md": "# vendor" });
	const result = audit(dir) as Audit;
	const paths = result.files.map((f: FileEntry) => f.path);
	expect(paths).toContain("ATTRIBUTION.md");
});

test("dir with ONLY ATTRIBUTION.md → vendor: true, files[] has one entry", () => {
	const dir = makeSkill("only-attribution", { "ATTRIBUTION.md": "# vendor" });
	const result = audit(dir) as Audit;
	expect(result).not.toBeNull();
	expect(result!.vendor).toBe(true);
	expect(result!.files).toHaveLength(1);
	expect(result!.files[0].path).toBe("ATTRIBUTION.md");
});

test("EP tokens exactly at threshold → no issue", () => {
	const threshold = 100;
	const byteCount = threshold * 4;
	const content = "x".repeat(byteCount);
	const dir = makeSkill("ep-exact", { "SKILL.md": content });
	const result = audit(dir, threshold) as Audit;
	expect(result.issues.filter((i: string) => i.includes("exceeds"))).toHaveLength(0);
});

test("EP tokens 1 over threshold → issue reported", () => {
	const threshold = 100;
	const content = "x".repeat(threshold * 4 + 2);
	const dir = makeSkill("ep-over", { "SKILL.md": content });
	const result = audit(dir, threshold) as Audit;
	expect(result.issues.some((i: string) => i.includes("exceeds"))).toBe(true);
});

test("EP threshold not applied to non-entry-point files", () => {
	const threshold = 10;
	const bigRef = "x".repeat(threshold * 4 * 100);
	const dir = makeSkill("ref-large", { "SKILL.md": "# tiny", "references/big.md": bigRef });
	const result = audit(dir, threshold) as Audit;
	expect(result.issues.filter((i: string) => i.includes("exceeds"))).toHaveLength(0);
});

test("description exactly 500 chars → no issue", () => {
	const dir = makeSkill("desc-exact", { "SKILL.md": skillMdWithDesc(500) });
	expect((audit(dir) as Audit).issues.filter((i: string) => i.includes("description"))).toHaveLength(0);
});

test("description 501 chars → issue reported", () => {
	const dir = makeSkill("desc-over", { "SKILL.md": skillMdWithDesc(501) });
	const result = audit(dir) as Audit;
	expect(result.issues.some((i: string) => i.includes("description") && i.includes("501"))).toBe(true);
});

test("no SKILL.md (only lowercase skill.md) → description check returns 0, no desc issue", () => {
	const dir = makeSkill("desc-lowercase", { "skill.md": skillMdWithDesc(600) });
	const result = audit(dir) as Audit;
	expect(result.issues.filter((i: string) => i.includes("description"))).toHaveLength(0);
	expect(result.issues.some((i: string) => i.includes("lowercase"))).toBe(true);
});

test("doFix=true on a dir with no issues → fixed[] stays empty", () => {
	const dir = makeSkill("clean-fix", { "SKILL.md": "# clean" });
	const result = audit(dir, 1500, true) as Audit;
	expect(result.fixed).toEqual([]);
	expect(result.issues).toEqual([]);
});

test("--fix does not overwrite SKILL.md when skill.md also exists", () => {
	const dir = makeSkill("both-entries", { "SKILL.md": "# upper\n", "skill.md": "# lower\n" });
	const names = readdirSync(dir);
	if (!names.includes("SKILL.md") || !names.includes("skill.md")) return;
	const result = audit(dir, 1500, true) as Audit;
	expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toBe("# upper\n");
	expect(result.issues.some((i) => i.includes("both SKILL.md and skill.md"))).toBe(true);
});

test("a relative skill dir with a relative link finishes and resolves the link", () => {
	const dir = makeSkill("rel-skill", { "SKILL.md": "[r](references/real.md)\n", "references/real.md": "# r" });
	const cwd = process.cwd();
	process.chdir(dir);
	try {
		expect((audit(".") as Audit).issues).toEqual([]);
	} finally {
		process.chdir(cwd);
	}
});
