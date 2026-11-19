import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, symlinkSync } from "node:fs";

import { frontmatterBlock, makeAdrRepo, NOT_INITIALIZED, disposeAdrRepos, TOC_MARKER } from "./adr-fixtures";

setDefaultTimeout(30_000);

afterEach(disposeAdrRepos);

const LEVEL_NAMES = ["eli5", "high-school", "college", "phd", "technical"];

describe("adr levels", () => {
	test("LEVELS lists the five levels in order", async () => {
		const levels = await import("../src/adr/levels");
		expect([...levels.LEVELS]).toEqual(LEVEL_NAMES);
	});

	test("gradeLimit maps levels to 4, 10, 14, null, null", async () => {
		const { gradeLimit } = await import("../src/adr/levels");
		expect(LEVEL_NAMES.map((level) => gradeLimit(level as never))).toEqual([4, 10, 14, null, null]);
	});

	test("parseLevel returns exact lowercase input and rejects the rest with all five values", async () => {
		const { parseLevel } = await import("../src/adr/levels");
		expect(parseLevel("phd")).toBe("phd");
		expect(parseLevel("technical")).toBe("technical");
		for (const bad of ["grad", "PhD", "College", ""]) {
			expect(() => parseLevel(bad)).toThrow(new RegExp(LEVEL_NAMES.join(".*")));
		}
	});
});

describe("adr templates", () => {
	test("constants carry the marker, sections and header lines", async () => {
		const templates = await import("../src/adr/templates");
		expect(templates.TOC_MARKER).toBe(TOC_MARKER);
		expect(templates.HUMAN_SECTIONS).toEqual(["Context", "Decision", "Consequences", "Diagram", "Other options"]);
		for (const line of ["Status:", "Date:", "Topic:", "Level:"]) expect(templates.HUMAN_TEMPLATE).toContain(line);
		for (const section of templates.HUMAN_SECTIONS) expect(templates.HUMAN_TEMPLATE).toContain(section);
		expect(templates.HUMAN_TEMPLATE).toContain("```mermaid");
		expect(templates.AGENT_TEMPLATE).toContain("covers: []");
		expect(templates.AGENT_TEMPLATE).toContain("No agent rules.");
	});
});

describe("adr init", () => {
	test("creates both directories, toc.md and README.md with the marker and no template.md", async () => {
		const repo = await makeAdrRepo({ init: false });
		const run = await repo.adr(["init"]);
		expect(run.exitCode).toBe(0);
		expect(repo.list("docs/adr")).toEqual(["toc.md"]);
		expect(repo.list(".agents/decisions")).toEqual(["README.md"]);
		expect(repo.read("docs/adr/toc.md")).toContain(TOC_MARKER);
		expect(repo.read(".agents/decisions/README.md")).toContain(TOC_MARKER);
	});

	test("writes level: high-school into the README frontmatter by default", async () => {
		const repo = await makeAdrRepo();
		expect(frontmatterBlock(repo.read(".agents/decisions/README.md"))).toContain("level: high-school");
	});

	test("--level college lands as level: college in the README frontmatter", async () => {
		const repo = await makeAdrRepo({ level: "college" });
		expect(frontmatterBlock(repo.read(".agents/decisions/README.md"))).toContain("level: college");
	});

	test("--level with an unknown value exits 2 and lists the five levels", async () => {
		const repo = await makeAdrRepo({ init: false });
		const run = await repo.adr(["init", "--level", "grad"]);
		expect(run.exitCode).toBe(2);
		for (const level of LEVEL_NAMES) expect(run.stderr).toContain(level);
	});

	test("run twice leaves every file unchanged", async () => {
		const repo = await makeAdrRepo({ level: "college" });
		const before = repo.snapshot();
		const run = await repo.adr(["init"]);
		expect(run.exitCode).toBe(0);
		expect(repo.snapshot()).toEqual(before);
	});

	test("never rewrites an existing toc.md that has the marker", async () => {
		const repo = await makeAdrRepo({ init: false });
		const custom = `# Mine\n\nHand written.\n\n${TOC_MARKER}\n`;
		repo.write("docs/adr/toc.md", custom);
		const run = await repo.adr(["init", "--level", "college"]);
		expect(run.exitCode).toBe(0);
		expect(repo.read("docs/adr/toc.md")).toBe(custom);
		expect(repo.exists(".agents/decisions/README.md")).toBe(true);
	});

	test("exits 2 and names the marker when toc.md has none", async () => {
		const repo = await makeAdrRepo({ init: false });
		repo.write("docs/adr/toc.md", "# Decisions\n\nNo marker here.\n");
		const run = await repo.adr(["init"]);
		expect(run.exitCode).toBe(2);
		expect(run.stderr).toContain("<!-- adr:index -->");
		expect(repo.read("docs/adr/toc.md")).toBe("# Decisions\n\nNo marker here.\n");
	});

	test("exits 2 and names the marker when README.md has none", async () => {
		const repo = await makeAdrRepo({ init: false });
		repo.write(".agents/decisions/README.md", "# Decisions\n");
		const run = await repo.adr(["init"]);
		expect(run.exitCode).toBe(2);
		expect(run.stderr).toContain("<!-- adr:index -->");
		expect(repo.read(".agents/decisions/README.md")).toBe("# Decisions\n");
	});
});

describe("adr new", () => {
	test("writes a paired ADR and decision with the same number and slug, a Topic line and a link", async () => {
		const repo = await makeAdrRepo();
		const run = await repo.create("Use X", "Tooling");
		expect(run.exitCode).toBe(0);
		expect(repo.list("docs/adr")).toEqual(["0001-use-x.md", "toc.md"]);
		expect(repo.list(".agents/decisions")).toEqual(["0001-use-x.md", "README.md"]);
		expect(repo.read("docs/adr/0001-use-x.md")).toMatch(/^Topic: Tooling$/m);
		expect(repo.read(".agents/decisions/0001-use-x.md")).toContain("0001-use-x.md");
		expect(repo.read(".agents/decisions/0001-use-x.md")).toMatch(/\]\([^)]*docs\/adr\/0001-use-x\.md\)/);
	});

	test("the ADR carries Status, Date and the human sections", async () => {
		const repo = await makeAdrRepo();
		await repo.create("Use X", "Tooling");
		const adr = repo.read("docs/adr/0001-use-x.md");
		expect(adr).toMatch(/^Status: .+$/m);
		expect(adr).toMatch(/^Date: \d{4}-\d{2}-\d{2}$/m);
		for (const section of ["Context", "Decision", "Consequences", "Diagram", "Other options"]) {
			expect(adr).toMatch(new RegExp(`^#+ ${section}$`, "m"));
		}
	});

	test("--covers lands in the decision frontmatter", async () => {
		const repo = await makeAdrRepo();
		const run = await repo.create("Use X", "Tooling", ["--covers", "pkg/a/**", "--covers", "pkg/b/*.ts"]);
		expect(run.exitCode).toBe(0);
		const decision = repo.read(".agents/decisions/0001-use-x.md");
		expect(decision).toContain("pkg/a/**");
		expect(decision).toContain("pkg/b/*.ts");
	});

	test("numbers max+1 over both directories, zero-padded, ignoring toc, README, template and non-numbered files", async () => {
		const repo = await makeAdrRepo();
		await repo.create("Seed", "Tooling");
		repo.renumber("0001-seed", "0007-seed");
		repo.write("docs/adr/template.md", "# template\n");
		repo.write("docs/adr/notes.md", "# notes\n");
		repo.write(".agents/decisions/template.md", "# template\n");
		repo.write(".agents/decisions/12-short.md", "# short\n");
		const run = await repo.create("Next one", "Tooling");
		expect(run.exitCode).toBe(0);
		expect(repo.exists("docs/adr/0008-next-one.md")).toBe(true);
		expect(repo.exists(".agents/decisions/0008-next-one.md")).toBe(true);
	});

	test("counts a number that exists in only one directory", async () => {
		const repo = await makeAdrRepo();
		repo.write(".agents/decisions/0004-solo.md", "---\ncovers: []\n---\nNo agent rules.\n");
		const run = await repo.create("After solo", "Tooling");
		expect(run.exitCode).toBe(0);
		expect(repo.exists("docs/adr/0005-after-solo.md")).toBe(true);
		expect(repo.exists(".agents/decisions/0005-after-solo.md")).toBe(true);
	});

	test("the first record is 0001 and the second is 0002", async () => {
		const repo = await makeAdrRepo();
		await repo.create("One", "Tooling");
		await repo.create("Two", "Tooling");
		expect(repo.list("docs/adr")).toEqual(["0001-one.md", "0002-two.md", "toc.md"]);
	});

	test("without --level writes no Level line", async () => {
		const repo = await makeAdrRepo();
		await repo.create("Use X", "Tooling");
		expect(repo.read("docs/adr/0001-use-x.md")).not.toMatch(/^Level:/m);
	});

	test.each(["phd", "technical", "college"])("--level %s succeeds and stores the typed value", async (level) => {
		const repo = await makeAdrRepo();
		const run = await repo.create("Use X", "Tooling", ["--level", level]);
		expect(run.exitCode).toBe(0);
		expect(repo.read("docs/adr/0001-use-x.md")).toMatch(new RegExp(`^Level: ${level}$`, "m"));
	});

	test("--level grad exits 2, lists the five levels and writes nothing", async () => {
		const repo = await makeAdrRepo();
		const run = await repo.create("Use X", "Tooling", ["--level", "grad"]);
		expect(run.exitCode).toBe(2);
		for (const level of LEVEL_NAMES) expect(run.stderr).toContain(level);
		expect(repo.list("docs/adr")).toEqual(["toc.md"]);
		expect(repo.list(".agents/decisions")).toEqual(["README.md"]);
	});

	test("exits 2 without --topic and writes nothing", async () => {
		const repo = await makeAdrRepo();
		const run = await repo.adr(["new", "Use X"]);
		expect(run.exitCode).toBe(2);
		expect(repo.list("docs/adr")).toEqual(["toc.md"]);
		expect(repo.list(".agents/decisions")).toEqual(["README.md"]);
	});

	test("exits 2 for an empty title", async () => {
		const repo = await makeAdrRepo();
		const run = await repo.create("", "Tooling");
		expect(run.exitCode).toBe(2);
		expect(repo.list("docs/adr")).toEqual(["toc.md"]);
	});

	test("exits 2 for a title that slugifies to empty", async () => {
		const repo = await makeAdrRepo();
		const run = await repo.create("!!! ???", "Tooling");
		expect(run.exitCode).toBe(2);
		expect(repo.list("docs/adr")).toEqual(["toc.md"]);
		expect(repo.list(".agents/decisions")).toEqual(["README.md"]);
	});

	test.skipIf(process.getuid?.() === 0)("a failing decision write leaves no ADR file behind", async () => {
		const repo = await makeAdrRepo();
		chmodSync(`${repo.root}/.agents/decisions`, 0o555);
		try {
			const run = await repo.create("Use X", "Tooling");
			expect(run.exitCode).not.toBe(0);
		} finally {
			chmodSync(`${repo.root}/.agents/decisions`, 0o755);
		}
		expect(repo.list("docs/adr")).toEqual(["toc.md"]);
		expect(repo.list(".agents/decisions")).toEqual(["README.md"]);
	});

	test("keeps placeholder-looking text in the title and covers literal", async () => {
		const repo = await makeAdrRepo();
		const run = await repo.create("Use {{topic}} and {{date}}", "Tooling", ["--covers", "pkg/{{number}}/**"]);
		expect(run.exitCode).toBe(0);
		const adr = repo.read("docs/adr/0001-use-topic-and-date.md");
		expect(adr).toContain("# Use {{topic}} and {{date}}\n");
		expect(adr).toContain("Topic: Tooling\n");
		expect(repo.read(".agents/decisions/0001-use-topic-and-date.md")).toContain('covers: ["pkg/{{number}}/**"]');
	});

	test("ignores leftover .tmp files when numbering", async () => {
		const repo = await makeAdrRepo();
		repo.write("docs/adr/0009-stale.md.tmp", "x");
		await repo.create("Use X", "Tooling");
		expect(repo.exists("docs/adr/0001-use-x.md")).toBe(true);
	});

	test("runs index so both indexes list the new record", async () => {
		const repo = await makeAdrRepo();
		await repo.create("Use X", "Tooling");
		expect(repo.read("docs/adr/toc.md")).toContain("[0001 — Use X](0001-use-x.md)");
		expect(repo.read(".agents/decisions/README.md")).toContain("Use X");
	});

	test("acceptance: new with --covers lists the record under Tooling in both indexes", async () => {
		const repo = await makeAdrRepo();
		const run = await repo.create("Use X", "Tooling", ["--covers", "pkg/a/**"]);
		expect(run.exitCode).toBe(0);
		const toc = repo.read("docs/adr/toc.md");
		expect(toc).toMatch(/### Tooling\n+- \[0001 — Use X\]\(0001-use-x\.md\)/);
		const readme = repo.read(".agents/decisions/README.md");
		const row = readme.split("\n").find((line) => line.includes("Use X")) ?? "";
		expect(row).toContain("Tooling");
		expect(row).toContain("pkg/a/**");
		expect(row).toContain("No agent rules.");
	});
});

describe("adr hardening", () => {
	test("new rejects control characters in the title and topic", async () => {
		const repo = await makeAdrRepo();
		for (const [title, topic] of [["Use\nX", "Tooling"], ["Use X", "Tool\u0007ing"]]) {
			const run = await repo.create(title as string, topic as string);
			expect(run.exitCode).toBe(2);
		}
		expect(repo.list("docs/adr").filter((name) => name !== "toc.md")).toEqual([]);
	});

	test("new numbers past an existing record and leaves it intact", async () => {
		const repo = await makeAdrRepo();
		repo.write("docs/adr/0001-use-x.md", "KEEP ME\n");
		repo.write(".agents/decisions/0001-use-x.md", "KEEP TOO\n");
		const run = await repo.create("Use X", "Tooling");
		expect(repo.read("docs/adr/0001-use-x.md")).toBe("KEEP ME\n");
		expect(repo.read(".agents/decisions/0001-use-x.md")).toBe("KEEP TOO\n");
		expect(run.exitCode).toBe(0);
		expect(repo.list("docs/adr").some((name) => name.endsWith(".tmp"))).toBe(false);
	});

	test.skipIf(process.getuid?.() === 0)("a failed write leaves no temp files behind", async () => {
		const repo = await makeAdrRepo();
		chmodSync(`${repo.root}/.agents/decisions`, 0o555);
		const run = await repo.create("Use X", "Tooling");
		chmodSync(`${repo.root}/.agents/decisions`, 0o755);
		expect(run.exitCode).not.toBe(0);
		expect(repo.list("docs/adr").filter((name) => name !== "toc.md")).toEqual([]);
		expect(repo.list(".agents/decisions").filter((name) => name !== "README.md")).toEqual([]);
	});

	test("index refuses to write through a symlinked index file", async () => {
		const repo = await makeAdrRepo();
		repo.write("elsewhere.md", `${TOC_MARKER}\n`);
		rmSync(`${repo.root}/docs/adr/toc.md`);
		symlinkSync(`${repo.root}/elsewhere.md`, `${repo.root}/docs/adr/toc.md`);
		const run = await repo.adr(["index"]);
		expect(run.exitCode).toBe(2);
		expect(repo.read("elsewhere.md")).toBe(`${TOC_MARKER}\n`);
	});

	test("init refuses to write through a dangling symlink", async () => {
		const repo = await makeAdrRepo({ init: false });
		mkdirSync(`${repo.root}/docs/adr`, { recursive: true });
		symlinkSync(`${repo.root}/target.md`, `${repo.root}/docs/adr/toc.md`);
		const run = await repo.adr(["init"]);
		expect(run.exitCode).toBe(2);
		expect(repo.exists("target.md")).toBe(false);
	});

	test("the missing-marker message is identical for init and index", async () => {
		const repo = await makeAdrRepo();
		repo.write("docs/adr/toc.md", "# no marker\n");
		const index = await repo.adr(["index"]);
		const init = await repo.adr(["init"]);
		expect(index.stderr).toContain("has no <!-- adr:index --> marker");
		expect(init.stderr).toBe(index.stderr);
	});

	test("brackets in a title are escaped in toc link text", async () => {
		const repo = await makeAdrRepo();
		await repo.create("Use [x](http://evil) here", "Tooling");
		expect(repo.read("docs/adr/toc.md")).toContain("[0001 — Use \\[x\\](http://evil) here](0001-use-x-http-evil-here.md)");
	});

	test("usage text shows --covers as a repeatable flag", async () => {
		const repo = await makeAdrRepo();
		expect((await repo.adr(["--help"])).stdout).toContain("[--covers <glob>]...");
	});
});

describe("adr index", () => {
	async function seeded() {
		const repo = await makeAdrRepo({ level: "college" });
		await repo.create("Zeta thing", "Tooling");
		await repo.create("Alpha thing", "Build");
		await repo.create("Beta thing", "Tooling");
		return repo;
	}

	test("is stable: a second run writes the same bytes", async () => {
		const repo = await seeded();
		const before = repo.snapshot();
		const run = await repo.adr(["index"]);
		expect(run.exitCode).toBe(0);
		expect(repo.snapshot()).toEqual(before);
	});

	test("groups the toc by Topic alphabetically with numbers ascending inside each group", async () => {
		const repo = await seeded();
		const toc = repo.read("docs/adr/toc.md");
		const order = [
			"### Build",
			"- [0002 — Alpha thing](0002-alpha-thing.md)",
			"### Tooling",
			"- [0001 — Zeta thing](0001-zeta-thing.md)",
			"- [0003 — Beta thing](0003-beta-thing.md)",
		].map((needle) => toc.indexOf(needle));
		expect(order.every((index) => index >= 0)).toBe(true);
		expect(order).toEqual([...order].sort((a, b) => a - b));
		expect(toc.indexOf(TOC_MARKER)).toBeLessThan(order[0] ?? 0);
	});

	test("the README table has the five columns in order and one row per record", async () => {
		const repo = await seeded();
		const lines = repo.read(".agents/decisions/README.md").split("\n");
		const header = lines.find((line) => line.startsWith("|")) ?? "";
		const cells = header.split("|").map((cell) => cell.trim()).filter(Boolean);
		expect(cells).toEqual(["Number", "Title", "Topic", "Rule summary", "Covers"]);
		const rows = lines.filter((line) => /^\|\s*0\d{3}/.test(line));
		expect(rows).toHaveLength(3);
		expect(rows[0]).toContain("Tooling");
	});

	test("keeps text above the marker and the README frontmatter byte for byte", async () => {
		const repo = await seeded();
		const toc = repo.read("docs/adr/toc.md");
		repo.write("docs/adr/toc.md", `Custom heading line.\n\n${toc}`);
		const readme = repo.read(".agents/decisions/README.md");
		const frontmatter = frontmatterBlock(readme);
		expect(frontmatter).toContain("level: college");
		repo.write(".agents/decisions/README.md", readme.replace(TOC_MARKER, `Above-marker note.\n\n${TOC_MARKER}`));
		await repo.create("Gamma thing", "Build");
		expect(repo.read("docs/adr/toc.md").startsWith("Custom heading line.\n")).toBe(true);
		expect(repo.read(".agents/decisions/README.md")).toContain("Above-marker note.");
		expect(frontmatterBlock(repo.read(".agents/decisions/README.md"))).toBe(frontmatter);
		expect(repo.read("docs/adr/toc.md")).toContain("0004-gamma-thing.md");
	});

	test("replaces everything below the marker rather than appending", async () => {
		const repo = await seeded();
		const toc = repo.read("docs/adr/toc.md");
		repo.write("docs/adr/toc.md", `${toc}\nSTALE LINE\n`);
		await repo.adr(["index"]);
		expect(repo.read("docs/adr/toc.md")).not.toContain("STALE LINE");
	});

	test("renderIndexes is pure: same records give the same toc and README bodies", async () => {
		const { loadRecords } = await import("../src/adr/records");
		const { renderIndexes } = await import("../src/adr/index-gen");
		const repo = await seeded();
		const records = loadRecords(repo.root);
		expect(renderIndexes(records)).toEqual(renderIndexes(records));
	});
});

describe("adr relevant", () => {
	async function covered() {
		const repo = await makeAdrRepo();
		await repo.create("Use X", "Tooling", ["--covers", "pkg/a/**"]);
		await repo.create("No coverage", "Tooling");
		await repo.create("Other area", "Build", ["--covers", "pkg/b/*.ts"]);
		return repo;
	}

	test("prints matching decisions as number, title and path separated by tabs", async () => {
		const repo = await covered();
		const run = await repo.adr(["relevant", "pkg/a/x.ts"]);
		expect(run.exitCode).toBe(0);
		const lines = run.stdout.trim().split("\n");
		expect(lines).toHaveLength(1);
		const [number, title, path] = lines[0]?.split("\t") ?? [];
		expect(number).toBe("0001");
		expect(title).toBe("Use X");
		expect(path).toEndWith(".agents/decisions/0001-use-x.md");
	});

	test("never matches covers: []", async () => {
		const repo = await covered();
		const run = await repo.adr(["relevant", "anything/at/all.ts", "0002-no-coverage.md"]);
		expect(run.exitCode).toBe(0);
		expect(run.stdout).not.toContain("No coverage");
	});

	test("exits 0 with empty output on no match", async () => {
		const repo = await covered();
		const run = await repo.adr(["relevant", "src/unrelated.ts"]);
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toBe("");
	});

	test("normalizes ./ prefixes, absolute repo paths and backslashes", async () => {
		const repo = await covered();
		for (const path of ["./pkg/a/x.ts", `${repo.root}/pkg/a/x.ts`, "pkg\\a\\x.ts"]) {
			const run = await repo.adr(["relevant", path]);
			expect(run.stdout).toContain("0001\tUse X\t");
		}
	});

	test("lists a decision once when several files match, and several decisions across files", async () => {
		const repo = await covered();
		const run = await repo.adr(["relevant", "pkg/a/x.ts", "pkg/a/y.ts", "pkg/b/z.ts"]);
		const lines = run.stdout.trim().split("\n");
		expect(lines.map((line) => line.split("\t")[0]).sort()).toEqual(["0001", "0003"]);
	});

	test("--json prints [{number,title,path,adrPath}]", async () => {
		const repo = await covered();
		const run = await repo.adr(["relevant", "pkg/a/x.ts", "--json"]);
		expect(run.exitCode).toBe(0);
		const parsed = JSON.parse(run.stdout) as Array<Record<string, unknown>>;
		expect(parsed).toHaveLength(1);
		const [entry] = parsed;
		expect(Object.keys(entry ?? {}).sort()).toEqual(["adrPath", "number", "path", "title"]);
		expect(Number(entry?.number)).toBe(1);
		expect(entry?.title).toBe("Use X");
		expect(String(entry?.path)).toEndWith(".agents/decisions/0001-use-x.md");
		expect(String(entry?.adrPath)).toEndWith("docs/adr/0001-use-x.md");
	});

	test("--json on no match prints an empty array", async () => {
		const repo = await covered();
		const run = await repo.adr(["relevant", "src/unrelated.ts", "--json"]);
		expect(run.exitCode).toBe(0);
		expect(JSON.parse(run.stdout)).toEqual([]);
	});

	test("acceptance: relevant prints the decision for a changed file under pkg/a", async () => {
		const repo = await covered();
		const run = await repo.adr(["relevant", "pkg/a/x.ts"]);
		expect(run.stdout).toContain("Use X");
	});
});

describe("adr find", () => {
	async function ranked() {
		const repo = await makeAdrRepo();
		await repo.create("Plain thing", "Tooling");
		await repo.create("Cache one", "Tooling");
		await repo.create("Cache two", "Tooling");
		await repo.create("Unrelated", "Build");
		const adr = repo.read("docs/adr/0001-plain-thing.md");
		repo.write("docs/adr/0001-plain-thing.md", `${adr}\nWe use a cache. The cache stays warm.\n`);
		return repo;
	}

	function numbers(stdout: string): string[] {
		return stdout.trim().split("\n").filter(Boolean).map((line) => line.split("\t")[0] ?? "");
	}

	test("one title hit beats two body hits, equal scores order by number, zero scores are omitted", async () => {
		const repo = await ranked();
		const run = await repo.adr(["find", "cache"]);
		expect(run.exitCode).toBe(0);
		expect(numbers(run.stdout)).toEqual(["0002", "0003", "0001"]);
	});

	test("is case-insensitive", async () => {
		const repo = await ranked();
		const run = await repo.adr(["find", "CACHE"]);
		expect(numbers(run.stdout)).toEqual(["0002", "0003", "0001"]);
	});

	test("--json carries score, sorted descending with title hits first", async () => {
		const repo = await ranked();
		const run = await repo.adr(["find", "cache", "--json"]);
		expect(run.exitCode).toBe(0);
		const parsed = JSON.parse(run.stdout) as Array<Record<string, unknown>>;
		expect(parsed.map((entry) => Number(entry.number))).toEqual([2, 3, 1]);
		for (const entry of parsed) {
			expect(Object.keys(entry).sort()).toEqual(["adrPath", "number", "path", "score", "title"]);
			expect(typeof entry.score).toBe("number");
		}
		const scores = parsed.map((entry) => entry.score as number);
		expect(scores[0]).toBe(scores[1] ?? -1);
		expect(scores[1]).toBeGreaterThan(scores[2] ?? Number.POSITIVE_INFINITY);
		expect(scores[2]).toBeGreaterThanOrEqual(2);
	});

	test("matches words in the body of the ADR", async () => {
		const repo = await ranked();
		const run = await repo.adr(["find", "warm"]);
		expect(numbers(run.stdout)).toEqual(["0001"]);
	});

	test("exits 0 with empty output when nothing matches", async () => {
		const repo = await ranked();
		const run = await repo.adr(["find", "nonexistentword"]);
		expect(run.exitCode).toBe(0);
		expect(run.stdout.trim()).toBe("");
	});

	test("has no --level flag", async () => {
		const repo = await ranked();
		const run = await repo.adr(["find", "cache", "--level", "college"]);
		expect(run.exitCode).toBe(2);
		expect(run.stderr).toContain("find <words...>");
	});
});

describe("adr before init", () => {
	const VERBS: Array<[string, string[]]> = [
		["new", ["new", "Use X", "--topic", "Tooling"]],
		["index", ["index"]],
		["lint", ["lint"]],
		["relevant", ["relevant", "pkg/a/x.ts"]],
		["find", ["find", "cache"]],
	];

	test.each(VERBS)("%s exits 2 with the not-initialized message", async (_verb, args) => {
		const repo = await makeAdrRepo({ init: false });
		const run = await repo.adr(args);
		expect(run.exitCode).toBe(2);
		expect(run.stderr).toContain(NOT_INITIALIZED);
		expect(repo.exists("docs/adr")).toBe(false);
	});

	test("a bare .agents/decisions directory does not count as initialized", async () => {
		const repo = await makeAdrRepo({ init: false });
		repo.write(".agents/decisions/0001-old.md", "# old\n");
		const run = await repo.adr(["relevant", "pkg/a/x.ts"]);
		expect(run.exitCode).toBe(2);
		expect(run.stderr).toContain(NOT_INITIALIZED);
	});
});

describe("adr flag hardening", () => {
	test.each([
		[["--topic", "--level", "--covers", "x"]],
		[["--topic", "a", "--topic", "b"]],
		[["--topic", "a", "--level", "college", "--level", "phd"]],
		[["--topic", "a", "--covers", "--level"]],
	])("new rejects %j with exit 2 and writes nothing", async (flags) => {
		const repo = await makeAdrRepo();
		const run = await repo.adr(["new", "Use X", ...flags]);
		expect(run.exitCode).toBe(2);
		expect(repo.list("docs/adr")).toEqual(["toc.md"]);
	});

	test("init keeps an existing README level and says so on stderr", async () => {
		const repo = await makeAdrRepo({ level: "college" });
		const run = await repo.adr(["init", "--level", "phd"]);
		expect(run.exitCode).toBe(0);
		expect(run.stderr).toContain("college");
		expect(repo.read(".agents/decisions/README.md")).toContain("level: college");
	});

	test("index escapes a backslash in a title before the pipe", async () => {
		const repo = await makeAdrRepo();
		await repo.create("Use a\\b | c", "Tooling");
		const readme = repo.read(".agents/decisions/README.md");
		expect(readme).toContain("a\\\\b \\| c");
	});
});
