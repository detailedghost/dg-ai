import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	apply,
	detectDanglingReferences,
	findExistingRouter,
	headingKeyword,
	main,
	parseSections,
} from "../src/skill-split";

let tmp: string;
let skillDir: string;
let origStateDir: string | undefined;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "skill-split-test-"));
	skillDir = join(tmp, "my-skill");
	mkdirSync(skillDir, { recursive: true });
	origStateDir = process.env.AI_STATE_DIR;
	process.env.AI_STATE_DIR = join(tmp, "state");
});

afterEach(() => {
	if (origStateDir === undefined) delete process.env.AI_STATE_DIR;
	else process.env.AI_STATE_DIR = origStateDir;
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

describe("parseSections", () => {
	test("a fenced ``` block containing a nested ~~~ line does not close early", () => {
		const lines = ["## Keep", "```", "~~~", "## Phantom (inside fence)", "~~~", "```", "## Real second section"];
		const { sections } = parseSections(lines);
		expect(sections.map((s) => s.heading)).toEqual(["Keep", "Real second section"]);
	});

	test("dedupes duplicate headings with a numeric suffix", () => {
		const lines = ["## Notes", "a", "## Notes", "b"];
		const { sections } = parseSections(lines);
		expect(sections.map((s) => s.slug)).toEqual(["notes", "notes-2"]);
	});
});

describe("findExistingRouter / headingKeyword", () => {
	test("finds a Routing heading not among the moved slugs", () => {
		const lines = ["## Routing", "x", "## Dimensions", "y"];
		const { sections } = parseSections(lines);
		const router = findExistingRouter(sections, new Set(["dimensions"]));
		expect(router?.heading).toBe("Routing");
	});

	test("picks the longest significant word", () => {
		expect(headingKeyword("Dimensions (quality only — see Out of scope)")).toBe("Dimensions");
	});
});

describe("detectDanglingReferences", () => {
	test("flags a reference to a moved heading via above/below", () => {
		const bySlug = new Map([["dimensions", { slug: "dimensions", heading: "Dimensions", startLine: 0, endLine: 1, tokens: 1 }]]);
		const warnings = detectDanglingReferences(
			"see the Dimensions above for details",
			[{ slug: "dimensions", dest: "references/dims.md" }],
			bySlug,
		);
		expect(warnings.length).toBe(1);
	});
});

describe("apply", () => {
	test("moves a section verbatim and inserts a placeholder router", () => {
		writeEntry("# Skill\n\n## Keep\n\nkeep this\n\n## Move Me\n\nmove this content\n");
		const manifestPath = writeManifest({ skillDir, moves: [{ slug: "move-me", dest: "references/moved.md" }] });

		apply(manifestPath);

		const entry = readFileSync(join(skillDir, "SKILL.md"), "utf8");
		expect(entry).not.toContain("move this content");
		expect(entry).toContain("## Routing");
		expect(entry).toContain("| Move Me | `references/moved.md` |");

		const moved = readFileSync(join(skillDir, "references/moved.md"), "utf8");
		expect(moved).toContain("# Move Me");
		expect(moved).toContain("move this content");
	});

	test("merges into an existing router table instead of adding a second one", () => {
		writeEntry(
			"# Skill\n\n## Routing\n\n| Task | Read |\n|---|---|\n| Other | `references/other.md` |\n\n## Move Me\n\nbody\n",
		);
		const manifestPath = writeManifest({ skillDir, moves: [{ slug: "move-me", dest: "references/moved.md" }] });
		apply(manifestPath);
		const entry = readFileSync(join(skillDir, "SKILL.md"), "utf8");
		expect(entry.match(/## Routing/g)?.length).toBe(1);
		expect(entry).toContain("| Other | `references/other.md` |");
		expect(entry).toContain("| Move Me | `references/moved.md` |");
	});

	test("appends to an existing dest file without duplicating its H1", () => {
		mkdirSync(join(skillDir, "references"), { recursive: true });
		writeFileSync(join(skillDir, "references/moved.md"), "# Moved\n\nalready here\n");
		writeEntry("# Skill\n\n## Move Me\n\nnew body\n");
		const manifestPath = writeManifest({ skillDir, moves: [{ slug: "move-me", dest: "references/moved.md" }] });
		apply(manifestPath);
		const moved = readFileSync(join(skillDir, "references/moved.md"), "utf8");
		expect(moved.match(/^# /gm)?.length).toBe(1);
		expect(moved).toContain("already here");
		expect(moved).toContain("new body");
	});

	test("writes a pre-change backup under the state root with the original content", () => {
		writeEntry("# Skill\n\n## Move Me\n\nbody\n");
		const manifestPath = writeManifest({ skillDir, moves: [{ slug: "move-me", dest: "references/moved.md" }] });

		const logs: string[] = [];
		const orig = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: string) => {
			logs.push(chunk);
			return true;
		}) as typeof process.stdout.write;
		try {
			apply(manifestPath);
		} finally {
			process.stdout.write = orig;
		}
		const { backup } = JSON.parse(logs.join(""));
		expect(backup.startsWith(join(tmp, "state"))).toBe(true);
		expect(readFileSync(join(backup, "SKILL.md"), "utf8")).toContain("body");
	});

	test("rejects an unknown section slug", () => {
		writeEntry("# Skill\n\n## Keep\n\nx\n");
		const manifestPath = writeManifest({ skillDir, moves: [{ slug: "nope", dest: "references/x.md" }] });
		expect(() => apply(manifestPath)).toThrow(/unknown section slug/);
	});
});

describe("main (CLI)", () => {
	test("--list prints a JSON section inventory", () => {
		writeEntry("# Skill\n\n## Keep\n\nx\n");
		const logs: string[] = [];
		const orig = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: string) => {
			logs.push(chunk);
			return true;
		}) as typeof process.stdout.write;
		let code: number;
		try {
			code = main(["--list", skillDir]);
		} finally {
			process.stdout.write = orig;
		}
		expect(code).toBe(0);
		const parsed = JSON.parse(logs.join(""));
		expect(parsed.sections.map((s: { heading: string }) => s.heading)).toEqual(["Keep"]);
	});

	test("usage error exits 2 with no recognized flags", () => {
		expect(main([])).toBe(2);
	});

	test("--apply with a missing manifest path exits 2", () => {
		expect(main(["--apply", join(tmp, "missing.json")])).toBe(2);
	});
});
