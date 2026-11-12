import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { headingKeyword } from "../src/skill/audit";
import { applyManifest, detectDanglingReferences, findExistingRouter, parseSections, SplitError } from "../src/skill/split";

let tmp: string;
let skillDir: string;
let origStateDir: string | undefined;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "skill-split-test-"));
	skillDir = join(tmp, "my-skill");
	mkdirSync(skillDir, { recursive: true });
	origStateDir = process.env["AI_STATE_DIR"];
	process.env["AI_STATE_DIR"] = join(tmp, "state");
});

afterEach(() => {
	if (origStateDir === undefined) delete process.env["AI_STATE_DIR"];
	else process.env["AI_STATE_DIR"] = origStateDir;
	rmSync(tmp, { recursive: true, force: true });
});

function writeEntry(content: string): string {
	const p = join(skillDir, "SKILL.md");
	writeFileSync(p, content);
	return p;
}

function writeManifest(manifest: unknown): string {
	const p = join(tmp, "manifest.json");
	writeFileSync(p, JSON.stringify(manifest));
	return p;
}

test("parseSections: a ``` block containing a nested ~~~ line does not close early", () => {
	const lines = ["## Keep", "```", "~~~", "## Phantom (inside fence)", "~~~", "```", "## Real second section"];
	const { sections } = parseSections(lines);
	expect(sections.map((s) => s.heading)).toEqual(["Keep", "Real second section"]);
});

test("parseSections: a ~~~ block containing a nested ``` line does not close early", () => {
	const lines = ["## Keep", "~~~", "```", "## Phantom (inside fence)", "```", "~~~", "## Real second section"];
	const { sections } = parseSections(lines);
	expect(sections.map((s) => s.heading)).toEqual(["Keep", "Real second section"]);
});

test("parseSections: matching fence type does close and resume section detection", () => {
	const lines = ["## A", "```", "code", "```", "## B"];
	const { sections } = parseSections(lines);
	expect(sections.map((s) => s.heading)).toEqual(["A", "B"]);
});

test("parseSections: duplicate headings get unique -2/-3 suffixed slugs, not collapsed", () => {
	const lines = ["## Setup", "first", "## Other", "middle", "## Setup", "second", "## Setup", "third"];
	const { sections } = parseSections(lines);
	const slugs = sections.map((s) => s.slug);
	expect(new Set(slugs).size).toBe(slugs.length);
	expect(slugs.filter((s) => s.startsWith("setup"))).toEqual(["setup", "setup-2", "setup-3"]);
});

test("apply: moving one of two duplicate-heading sections preserves the other's content", () => {
	writeEntry(["# Skill", "## Setup", "unique content A", "## Setup", "unique content B", ""].join("\n"));
	const manifest = writeManifest({
		skillDir,
		moves: [{ slug: "setup-2", dest: "references/setup.md" }],
	});
	applyManifest(manifest);

	const entry = readFileSync(join(skillDir, "SKILL.md"), "utf8");
	const ref = readFileSync(join(skillDir, "references/setup.md"), "utf8");
	expect(entry).toContain("unique content A");
	expect(entry).not.toContain("unique content B");
	expect(ref).toContain("unique content B");
});

test("headingKeyword: strips trailing parenthetical and picks the most distinctive word", () => {
	expect(headingKeyword("Dimensions (quality only — see Out of scope)")).toBe("Dimensions");
});

test("headingKeyword: returns undefined when no word is long enough", () => {
	expect(headingKeyword("Do It")).toBeUndefined();
});

test("detectDanglingReferences: flags a same-file back-reference to a moved section", () => {
	const bySlug = new Map([
		["dimensions", { slug: "dimensions", heading: "Dimensions (quality)", startLine: 0, endLine: 1, tokens: 1 }],
	]);
	const remaining = "Brief each with the eight Dimensions above and nothing else.";
	const warnings = detectDanglingReferences(remaining, [{ slug: "dimensions", dest: "references/d.md" }], bySlug);
	expect(warnings).toHaveLength(1);
	expect(warnings[0]).toContain("Dimensions");
});

test("detectDanglingReferences: no warning when the moved heading isn't mentioned again", () => {
	const bySlug = new Map([
		["dimensions", { slug: "dimensions", heading: "Dimensions (quality)", startLine: 0, endLine: 1, tokens: 1 }],
	]);
	const remaining = "Nothing here references anything moved.";
	expect(detectDanglingReferences(remaining, [{ slug: "dimensions", dest: "references/d.md" }], bySlug)).toEqual([]);
});

test("findExistingRouter: finds a pre-existing Routing section not among moved slugs", () => {
	const lines = ["## Routing", "| Task | Read |", "|---|---|", "## Details", "stuff"];
	const { sections } = parseSections(lines);
	const found = findExistingRouter(sections, new Set(["details"]));
	expect(found?.heading).toBe("Routing");
});

test("apply: merges new rows into an existing Routing table instead of duplicating the heading", () => {
	writeEntry(
		[
			"# Skill",
			"## Routing",
			"| Task | Read |",
			"|---|---|",
			"| Existing task | `references/existing.md` |",
			"## Details",
			"stuff to move",
			"",
		].join("\n"),
	);
	const manifest = writeManifest({ skillDir, moves: [{ slug: "details", dest: "references/details.md" }] });
	applyManifest(manifest);

	const entry = readFileSync(join(skillDir, "SKILL.md"), "utf8");
	expect(entry.match(/^## Routing$/gm)).toHaveLength(1);
	expect(entry).toContain("| Existing task | `references/existing.md` |");
	expect(entry).toContain("| Details | `references/details.md` |");
});

test("apply: falls back to a fresh placeholder router when none exists yet", () => {
	writeEntry(["# Skill", "## Details", "stuff to move", ""].join("\n"));
	const manifest = writeManifest({ skillDir, moves: [{ slug: "details", dest: "references/details.md" }] });
	applyManifest(manifest);

	const entry = readFileSync(join(skillDir, "SKILL.md"), "utf8");
	expect(entry.match(/^## Routing$/gm)).toHaveLength(1);
	expect(entry).toContain("| Details | `references/details.md` |");
});

test("apply: promotes H2 to H1 only when the dest file is new", () => {
	writeEntry(["# Skill", "## Topic", "content", ""].join("\n"));
	const manifest = writeManifest({ skillDir, moves: [{ slug: "topic", dest: "references/topic.md" }] });
	applyManifest(manifest);
	expect(readFileSync(join(skillDir, "references/topic.md"), "utf8")).toStartWith("# Topic");
});

test("apply: does not add a second H1 when appending to an existing reference file", () => {
	mkdirSync(join(skillDir, "references"), { recursive: true });
	writeFileSync(join(skillDir, "references/topic.md"), "# Topic Reference\n\nexisting content\n");
	writeEntry(["# Skill", "## More on topic", "new content", ""].join("\n"));
	const manifest = writeManifest({ skillDir, moves: [{ slug: "more-on-topic", dest: "references/topic.md" }] });
	applyManifest(manifest);

	const ref = readFileSync(join(skillDir, "references/topic.md"), "utf8");
	expect(ref.match(/^# /gm)).toHaveLength(1);
	expect(ref).toContain("## More on topic");
});

test("apply: rejects a manifest with no moves with a SplitError", () => {
	writeEntry(["# Skill", "## Details", "x", ""].join("\n"));
	const manifest = writeManifest({ skillDir, moves: [] });
	expect(() => applyManifest(manifest)).toThrow(SplitError);
});

test("parseSections: a generated suffix never collides with a real heading slug", () => {
	const { sections } = parseSections(["## Setup", "a", "## Setup", "b", "## Setup 2", "c"]);
	const slugs = sections.map((s) => s.slug);
	expect(new Set(slugs).size).toBe(3);
});

test("parseSections: a four-backtick fence holding a three-backtick example hides its headings", () => {
	const lines = ["## Real", "````md", "```", "## Example", "```", "````", "## After"];
	expect(parseSections(lines).sections.map((s) => s.heading)).toEqual(["Real", "After"]);
});

test("apply: rejects a move into the entry file before writing anything", () => {
	writeEntry(["# Skill", "## Details", "x", ""].join("\n"));
	const manifest = writeManifest({ skillDir, moves: [{ slug: "details", dest: "SKILL.md" }] });
	expect(() => applyManifest(manifest)).toThrow(SplitError);
	expect(readFileSync(join(skillDir, "SKILL.md"), "utf8")).toContain("## Details");
});

test("apply: malformed or null manifests throw SplitError", () => {
	const bad = join(tmp, "bad.json");
	writeFileSync(bad, "{ nope");
	expect(() => applyManifest(bad)).toThrow(SplitError);
	expect(() => applyManifest(writeManifest(null))).toThrow(SplitError);
});

test("apply: the backup of a symlinked skill dir keeps the original entry", () => {
	writeEntry(["# Skill", "## Details", "original", ""].join("\n"));
	const link = join(tmp, "linked-skill");
	symlinkSync(skillDir, link);
	const result = applyManifest(writeManifest({ skillDir: link, moves: [{ slug: "details", dest: "references/d.md" }] }));
	expect(readFileSync(join(result.backup, "SKILL.md"), "utf8")).toContain("## Details");
	expect(readdirSync(result.backup)).not.toContain("references");
});

test("apply: rows follow a File-first References table", () => {
	writeEntry(
		["# Skill", "## References", "| File | When to read |", "|---|---|", "| `references/a.md` | always |", "## Details", "x", ""].join(
			"\n",
		),
	);
	applyManifest(writeManifest({ skillDir, moves: [{ slug: "details", dest: "references/details.md" }] }));
	expect(readFileSync(join(skillDir, "SKILL.md"), "utf8")).toContain("| `references/details.md` | Details |");
});

test("parseSections: an indented fence still hides its headings", () => {
	const lines = ["## Real", "   ```", "## Example", "   ```", "## After"];
	expect(parseSections(lines).sections.map((s) => s.heading)).toEqual(["Real", "After"]);
});

test("apply: rejects a destination that is a symlink to the entry file", () => {
	writeEntry(["# Skill", "## Details", "x", ""].join("\n"));
	mkdirSync(join(skillDir, "references"), { recursive: true });
	symlinkSync(join(skillDir, "SKILL.md"), join(skillDir, "references", "alias.md"));
	const manifest = writeManifest({ skillDir, moves: [{ slug: "details", dest: "references/alias.md" }] });
	expect(() => applyManifest(manifest)).toThrow(SplitError);
	expect(readFileSync(join(skillDir, "SKILL.md"), "utf8")).toContain("## Details");
});

test("apply: rejects absolute and escaping destinations", () => {
	writeEntry(["# Skill", "## Details", "x", ""].join("\n"));
	for (const dest of ["/SKILL.md", "../other.md"]) {
		expect(() => applyManifest(writeManifest({ skillDir, moves: [{ slug: "details", dest }] }))).toThrow(SplitError);
	}
	expect(readFileSync(join(skillDir, "SKILL.md"), "utf8")).toContain("## Details");
});

test("apply: keeps retained blank lines verbatim", () => {
	writeEntry(["# Skill", "## Keep", "```", "a", "", "", "b", "```", "## Move", "m", ""].join("\n"));
	applyManifest(writeManifest({ skillDir, moves: [{ slug: "move", dest: "references/move.md" }] }));
	expect(readFileSync(join(skillDir, "SKILL.md"), "utf8")).toContain("a\n\n\nb");
});

test("apply: warns about moved relative links and kept fragment links", () => {
	writeEntry(["# Skill", "See [details](#details).", "## Details", "[sib](../other/SKILL.md)", ""].join("\n"));
	const result = applyManifest(writeManifest({ skillDir, moves: [{ slug: "details", dest: "references/details.md" }] }));
	expect(result.warnings.some((w) => w.includes("../other/SKILL.md"))).toBe(true);
	expect(result.warnings.some((w) => w.includes("#details"))).toBe(true);
});
