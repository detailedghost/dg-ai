import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { type AdrRepo, disposeAdrRepos, makeAdrRepo, NOT_INITIALIZED } from "./adr-fixtures";
import { git } from "./git-repo-fixtures";
import type { CliRun } from "./module-call";

setDefaultTimeout(30_000);

afterEach(disposeAdrRepos);

interface Finding {
	file: string;
	rule: string;
	message: string;
	grade?: number;
	limit?: number | null;
}

const KEY = "0001-use-queues";
const ADR_FILE = `docs/adr/${KEY}.md`;
const DECISION_FILE = `.agents/decisions/${KEY}.md`;

const HARD_TEXT =
	"The old community council voted to build a new bridge across the river because the heavy traffic caused expensive delays throughout the entire morning. Local engineers suggested that a second crossing would reduce congestion and improve health for walkers and drivers during busy weekday times.";

const EASY_PROSE = {
	context: "Jobs came in faster than we could run them.",
	decision: "We chose a queue. It holds each job until a worker is free.",
	consequences: "Work is safe. Jobs may run a bit later.",
	other: "We could run each job at once. That fails when load is high.",
};

interface AdrOptions {
	title?: string;
	header?: string;
	prose?: Partial<typeof EASY_PROSE>;
	diagram?: string;
	omit?: string;
	extra?: string;
}

function adrDoc(options: AdrOptions = {}): string {
	const prose = { ...EASY_PROSE, ...options.prose };
	const header = options.header ?? "Status: Accepted\nDate: 2026-01-01\nTopic: messaging\n";
	const diagram = options.diagram ?? "graph TD\n  A[Job] --> B[Queue]\n  B --> C[Worker]\n";
	const sections: Record<string, string> = {
		Context: prose.context,
		Decision: prose.decision,
		Consequences: prose.consequences,
		Diagram: `\`\`\`mermaid\n${diagram}\`\`\``,
		"Other options": prose.other,
	};
	const body = Object.entries(sections)
		.filter(([name]) => name !== options.omit)
		.map(([name, text]) => `## ${name}\n\n${text}\n`)
		.join("\n");
	return `# ${options.title ?? "Use queues"}\n\n${header}\n${body}${options.extra === undefined ? "" : `\n${options.extra}\n`}`;
}

function decisionDoc(options: { front?: string; link?: string; body?: string } = {}): string {
	const front = options.front ?? 'covers: ["src/**"]';
	const link = options.link ?? `[ADR 0001](../../docs/adr/${KEY}.md)`;
	return `---\n${front}\n---\n\n${link}\n\n${options.body ?? "- Send long work to the queue."}\n`;
}

async function reindex(repo: AdrRepo): Promise<void> {
	const run = await repo.adr(["index"]);
	if (run.exitCode !== 0) throw new Error(`adr index failed: ${run.stderr}`);
}

async function writePair(repo: AdrRepo, key: string, adr: string, decision: string): Promise<void> {
	repo.write(`docs/adr/${key}.md`, adr);
	repo.write(`.agents/decisions/${key}.md`, decision);
	await reindex(repo);
}

async function goodRepo(options: { level?: string } = {}): Promise<AdrRepo> {
	const repo = await makeAdrRepo(options);
	await writePair(repo, KEY, adrDoc(), decisionDoc());
	return repo;
}

async function findings(repo: AdrRepo, extra: string[] = ["--all"]): Promise<{ run: CliRun; found: Finding[] }> {
	const run = await repo.adr(["lint", ...extra, "--json"]);
	return { run, found: JSON.parse(run.stdout) as Finding[] };
}

function rulesOf(found: Finding[]): string[] {
	return found.map((finding) => finding.rule).sort();
}

describe("adr lint --all on a clean repo", () => {
	test("exits 0 and prints no findings", async () => {
		const repo = await goodRepo();
		const run = await repo.adr(["lint", "--all"]);
		expect(run.exitCode).toBe(0);
		expect(run.stdout.trim()).toBe("");
	});

	test("--json prints an empty array", async () => {
		const repo = await goodRepo();
		const { run, found } = await findings(repo);
		expect(run.exitCode).toBe(0);
		expect(found).toEqual([]);
	});

	test("accepts relative links, anchors, backticked paths and unfetched http links", async () => {
		const repo = await makeAdrRepo();
		const extra = `See [the context](#context) and [this record](${KEY}.md). Look at \`docs/adr/missing.md\`. Read [the web](http://127.0.0.1:1/never).`;
		await writePair(repo, KEY, adrDoc({ extra }), decisionDoc());
		const { run, found } = await findings(repo);
		expect(found).toEqual([]);
		expect(run.exitCode).toBe(0);
	});

	test("a freshly created record fails missing-mermaid until its diagram is filled", async () => {
		const repo = await makeAdrRepo();
		const created = await repo.create("Use queues", "messaging", ["--covers", "src/**"]);
		expect(created.exitCode).toBe(0);
		const { run, found } = await findings(repo);
		expect(run.exitCode).toBe(1);
		expect(rulesOf(found)).toContain("missing-mermaid");
	});
});

describe("adr lint per-record rules", () => {
	test("missing-mermaid: an empty Mermaid body fails", async () => {
		const repo = await makeAdrRepo();
		await writePair(repo, KEY, adrDoc({ diagram: "" }), decisionDoc());
		const { run, found } = await findings(repo);
		expect(run.exitCode).toBe(1);
		expect(rulesOf(found)).toEqual(["missing-mermaid"]);
	});

	test("missing-mermaid: no Mermaid block at all fails and prints the human line", async () => {
		const repo = await makeAdrRepo();
		const noBlock = adrDoc().replace(/```mermaid[\s\S]*?```/, "Nothing to draw.");
		await writePair(repo, KEY, noBlock, decisionDoc());
		const run = await repo.adr(["lint", "--all"]);
		expect(run.exitCode).toBe(1);
		expect(run.stdout).toMatch(new RegExp(`${ADR_FILE.replaceAll(".", "\\.")}: missing-mermaid: \\S`));
	});

	test.each(["Context", "Decision", "Consequences", "Diagram", "Other options"])("missing-section: %s is required", async (section) => {
		const repo = await makeAdrRepo();
		await writePair(repo, KEY, adrDoc({ omit: section }), decisionDoc());
		const { run, found } = await findings(repo);
		expect(run.exitCode).toBe(1);
		expect(found.map((finding) => finding.rule)).toContain("missing-section");
		expect(found.find((finding) => finding.rule === "missing-section")?.message).toContain(section);
	});

	test("missing-section: section names are case-sensitive", async () => {
		const repo = await makeAdrRepo();
		await writePair(repo, KEY, adrDoc().replace("## Other options", "## Other Options"), decisionDoc());
		const { found } = await findings(repo);
		expect(rulesOf(found)).toContain("missing-section");
	});

	test("missing-section: section order does not matter", async () => {
		const repo = await makeAdrRepo();
		const shuffled = adrDoc()
			.replace("## Context", "## Zeta")
			.replace("## Decision", "## Context")
			.replace("## Zeta", "## Decision");
		await writePair(repo, KEY, shuffled, decisionDoc());
		const { found } = await findings(repo);
		expect(found).toEqual([]);
	});

	test("grade-too-high: prose above the high-school limit fails with grade and limit", async () => {
		const repo = await makeAdrRepo();
		const hard = adrDoc({ prose: { context: HARD_TEXT, decision: HARD_TEXT, consequences: HARD_TEXT, other: HARD_TEXT } });
		await writePair(repo, KEY, hard, decisionDoc());
		const { run, found } = await findings(repo);
		expect(run.exitCode).toBe(1);
		expect(rulesOf(found)).toEqual(["grade-too-high"]);
		const [finding] = found;
		expect(finding?.limit).toBe(10);
		expect(finding?.grade).toBeGreaterThan(finding?.limit ?? Number.POSITIVE_INFINITY);
		expect(finding?.message).toMatch(/^grade \d+(\.\d)? exceeds high-school limit 10$/);
	});

	test("grade-too-high: the same prose passes under a college README level", async () => {
		const repo = await makeAdrRepo({ level: "college" });
		const hard = adrDoc({ prose: { context: HARD_TEXT, decision: HARD_TEXT, consequences: HARD_TEXT, other: HARD_TEXT } });
		await writePair(repo, KEY, hard, decisionDoc());
		const { run, found } = await findings(repo);
		expect(found).toEqual([]);
		expect(run.exitCode).toBe(0);
	});

	test("grade-too-high: an ADR Level line overrides the README level", async () => {
		const repo = await makeAdrRepo({ level: "college" });
		const hard = adrDoc({
			header: "Status: Accepted\nDate: 2026-01-01\nTopic: messaging\nLevel: eli5\n",
			prose: { context: HARD_TEXT, decision: HARD_TEXT, consequences: HARD_TEXT, other: HARD_TEXT },
		});
		await writePair(repo, KEY, hard, decisionDoc());
		const { found } = await findings(repo);
		expect(rulesOf(found)).toEqual(["grade-too-high"]);
		expect(found[0]?.limit).toBe(4);
	});

	test("technical level skips only the grade rule", async () => {
		const header = "Status: Accepted\nDate: 2026-01-01\nTopic: messaging\nLevel: technical\n";
		const hard = { context: HARD_TEXT, decision: HARD_TEXT, consequences: HARD_TEXT, other: HARD_TEXT };
		const clean = await makeAdrRepo();
		await writePair(clean, KEY, adrDoc({ header, prose: hard }), decisionDoc());
		expect((await findings(clean)).found).toEqual([]);

		const noDiagram = await makeAdrRepo();
		await writePair(noDiagram, KEY, adrDoc({ header, prose: hard, diagram: "" }), decisionDoc());
		expect(rulesOf((await findings(noDiagram)).found)).toEqual(["missing-mermaid"]);

		const noSection = await makeAdrRepo();
		await writePair(noSection, KEY, adrDoc({ header, prose: hard, omit: "Consequences" }), decisionDoc());
		expect(rulesOf((await findings(noSection)).found)).toEqual(["missing-section"]);
	});

	test("phd level skips the grade rule", async () => {
		const header = "Status: Accepted\nDate: 2026-01-01\nTopic: messaging\nLevel: phd\n";
		const repo = await makeAdrRepo();
		await writePair(repo, KEY, adrDoc({ header, prose: { context: HARD_TEXT, decision: HARD_TEXT } }), decisionDoc());
		expect((await findings(repo)).found).toEqual([]);
	});

	test("missing-status: no Status line fails", async () => {
		const repo = await makeAdrRepo();
		await writePair(repo, KEY, adrDoc({ header: "Date: 2026-01-01\nTopic: messaging\n" }), decisionDoc());
		expect(rulesOf((await findings(repo)).found)).toEqual(["missing-status"]);
	});

	test("missing-date: no Date line fails", async () => {
		const repo = await makeAdrRepo();
		await writePair(repo, KEY, adrDoc({ header: "Status: Accepted\nTopic: messaging\n" }), decisionDoc());
		expect(rulesOf((await findings(repo)).found)).toEqual(["missing-date"]);
	});

	test("missing-topic: no Topic line fails", async () => {
		const repo = await makeAdrRepo();
		await writePair(repo, KEY, adrDoc({ header: "Status: Accepted\nDate: 2026-01-01\n" }), decisionDoc());
		expect(rulesOf((await findings(repo)).found)).toContain("missing-topic");
	});

	test("missing-topic: an empty Topic value counts as missing", async () => {
		const repo = await makeAdrRepo();
		await writePair(repo, KEY, adrDoc({ header: "Status: Accepted\nDate: 2026-01-01\nTopic:\n" }), decisionDoc());
		expect(rulesOf((await findings(repo)).found)).toContain("missing-topic");
	});

	test("bad-level: an ADR Level outside the five levels fails", async () => {
		const repo = await makeAdrRepo();
		const header = "Status: Accepted\nDate: 2026-01-01\nTopic: messaging\nLevel: grad\n";
		await writePair(repo, KEY, adrDoc({ header }), decisionDoc());
		const { found } = await findings(repo);
		expect(rulesOf(found)).toEqual(["bad-level"]);
		expect(found[0]?.file.endsWith(ADR_FILE)).toBe(true);
	});

	test("bad-level: an invalid README level reports on the README", async () => {
		const repo = await goodRepo();
		const readme = repo.read(".agents/decisions/README.md").replace(/level: .*/, "level: grad");
		repo.write(".agents/decisions/README.md", readme);
		const { run, found } = await findings(repo);
		expect(run.exitCode).toBe(1);
		const bad = found.find((finding) => finding.rule === "bad-level");
		expect(bad?.file.endsWith(".agents/decisions/README.md")).toBe(true);
	});

	test("bad-level: a missing README level reports on the README", async () => {
		const repo = await goodRepo();
		const readme = repo.read(".agents/decisions/README.md").replace(/level: .*\n/, "");
		repo.write(".agents/decisions/README.md", readme);
		const { found } = await findings(repo);
		const bad = found.find((finding) => finding.rule === "bad-level");
		expect(bad?.file.endsWith(".agents/decisions/README.md")).toBe(true);
	});
});

describe("adr lint pair rules", () => {
	test("missing-pair: an ADR with no decision fails", async () => {
		const repo = await goodRepo();
		rmSync(join(repo.root, DECISION_FILE));
		await reindex(repo);
		const { run, found } = await findings(repo);
		expect(run.exitCode).toBe(1);
		expect(rulesOf(found)).toContain("missing-pair");
	});

	test("orphan-decision: a decision with no ADR fails", async () => {
		const repo = await goodRepo();
		rmSync(join(repo.root, ADR_FILE));
		await reindex(repo);
		const { run, found } = await findings(repo);
		expect(run.exitCode).toBe(1);
		expect(rulesOf(found)).toContain("orphan-decision");
	});

	test("missing-covers: a decision with no covers key fails", async () => {
		const repo = await makeAdrRepo();
		await writePair(repo, KEY, adrDoc(), decisionDoc({ front: "note: none" }));
		const { run, found } = await findings(repo);
		expect(run.exitCode).toBe(1);
		expect(rulesOf(found)).toEqual(["missing-covers"]);
		expect(found[0]?.file.endsWith(DECISION_FILE)).toBe(true);
	});

	test("missing-covers: an empty covers list passes", async () => {
		const repo = await makeAdrRepo();
		await writePair(repo, KEY, adrDoc(), decisionDoc({ front: "covers: []" }));
		const { run, found } = await findings(repo);
		expect(found).toEqual([]);
		expect(run.exitCode).toBe(0);
	});

	test("decision-too-long: 25 non-blank lines below the front matter, link line included, pass", async () => {
		const repo = await makeAdrRepo();
		const rules = Array.from({ length: 24 }, (_, i) => `- Rule ${i + 1}.`).join("\n\n");
		await writePair(repo, KEY, adrDoc(), decisionDoc({ body: rules }));
		const { run, found } = await findings(repo);
		expect(found).toEqual([]);
		expect(run.exitCode).toBe(0);
	});

	test("decision-too-long: 26 non-blank lines fail with the count and the cap", async () => {
		const repo = await makeAdrRepo();
		const rules = Array.from({ length: 25 }, (_, i) => `- Rule ${i + 1}.`).join("\n");
		await writePair(repo, KEY, adrDoc(), decisionDoc({ body: rules }));
		const { run, found } = await findings(repo);
		expect(run.exitCode).toBe(1);
		expect(found).toEqual([
			{ file: DECISION_FILE, rule: "decision-too-long", message: "26 non-blank lines exceed the 25-line cap" },
		]);
	});

	test("decision-too-long: front matter lines do not count", async () => {
		const repo = await makeAdrRepo();
		const front = ["covers:", ...Array.from({ length: 10 }, (_, i) => `  - "src/${i}/**"`)].join("\n");
		const rules = Array.from({ length: 24 }, (_, i) => `- Rule ${i + 1}.`).join("\n");
		await writePair(repo, KEY, adrDoc(), decisionDoc({ front, body: rules }));
		const { found } = await findings(repo);
		expect(found).toEqual([]);
	});

	test("broken-link: a decision that does not link its ADR fails", async () => {
		const repo = await makeAdrRepo();
		await writePair(repo, KEY, adrDoc(), decisionDoc({ link: "See the ADR." }));
		const { run, found } = await findings(repo);
		expect(run.exitCode).toBe(1);
		expect(rulesOf(found)).toEqual(["broken-link"]);
		expect(found[0]?.file.endsWith(DECISION_FILE)).toBe(true);
	});

	test("broken-link: a decision link to a missing file fails", async () => {
		const repo = await makeAdrRepo();
		await writePair(repo, KEY, adrDoc(), decisionDoc({ link: "[ADR 0001](../../docs/adr/9999-nope.md)" }));
		expect(rulesOf((await findings(repo)).found)).toContain("broken-link");
	});

	test("broken-link: a relative link to a missing file in an ADR fails", async () => {
		const repo = await makeAdrRepo();
		await writePair(repo, KEY, adrDoc({ extra: "See [more](./missing.md)." }), decisionDoc());
		const { found } = await findings(repo);
		expect(rulesOf(found)).toEqual(["broken-link"]);
		expect(found[0]?.file.endsWith(ADR_FILE)).toBe(true);
	});

	test("broken-link: percent-encoded and root-absolute targets resolve", async () => {
		const repo = await makeAdrRepo();
		repo.write("docs/my doc.md", "x\n");
		repo.write("docs/other.md", "x\n");
		await writePair(repo, KEY, adrDoc({ extra: "See [a](../my%20doc.md), [b](/docs/other.md) and [c](../bad%zz.md)." }), decisionDoc());
		const { found } = await findings(repo);
		const messages = found.map((finding) => finding.message);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("bad");
		expect(messages[0]).toContain("zz.md");
		expect(messages[0]).toContain("does not exist");
	});

	test("broken-link: a decision linking its ADR by a root-absolute or percent-encoded path passes", async () => {
		for (const link of [`/docs/adr/${KEY}.md`, `../../docs/adr/${KEY.replace("queues", "%71ueues")}.md`]) {
			const repo = await makeAdrRepo();
			await writePair(repo, KEY, adrDoc(), decisionDoc({ link: `[ADR](${link})` }));
			const { found } = await findings(repo);
			expect(found).toEqual([]);
		}
	});

	test("broken-link: an anchor with no matching heading fails", async () => {
		const repo = await makeAdrRepo();
		await writePair(repo, KEY, adrDoc({ extra: "See [there](#no-such-heading)." }), decisionDoc());
		expect(rulesOf((await findings(repo)).found)).toEqual(["broken-link"]);
	});

	test("broken-link: an anchor to a heading with punctuation resolves the GitHub way", async () => {
		const repo = await makeAdrRepo();
		await writePair(repo, KEY, adrDoc({ extra: "## Cost & Risk\n\nSee [it](#cost--risk) and [more](#other-options)." }), decisionDoc());
		expect((await findings(repo)).found).toEqual([]);
	});

	test("duplicate-number: two ADRs sharing a number fail", async () => {
		const repo = await goodRepo();
		await writePair(repo, "0001-other-idea", adrDoc({ title: "Other idea" }), decisionDoc({ link: "[ADR 0001](../../docs/adr/0001-other-idea.md)" }));
		const { run, found } = await findings(repo);
		expect(run.exitCode).toBe(1);
		expect(rulesOf(found)).toContain("duplicate-number");
	});

	test("duplicate-number: two decisions sharing a number fail", async () => {
		const repo = await goodRepo();
		await writePair(repo, "0002-second", adrDoc({ title: "Second" }), decisionDoc({ link: "[ADR 0002](../../docs/adr/0002-second.md)" }));
		repo.write(".agents/decisions/0002-third.md", decisionDoc({ link: "[ADR 0002](../../docs/adr/0002-second.md)" }));
		await reindex(repo);
		expect(rulesOf((await findings(repo)).found)).toContain("duplicate-number");
	});
});

describe("adr lint stale-index", () => {
	test("a stale toc fails and the message names dg adr index", async () => {
		const repo = await goodRepo();
		repo.write("docs/adr/toc.md", `${repo.read("docs/adr/toc.md")}\n- stale line\n`);
		const { run, found } = await findings(repo);
		expect(run.exitCode).toBe(1);
		expect(rulesOf(found)).toEqual(["stale-index"]);
		expect(found[0]?.file.endsWith("docs/adr/toc.md")).toBe(true);
		expect(found[0]?.message).toContain("dg adr index");
		const human = await repo.adr(["lint", "--all"]);
		expect(human.stdout).toContain("stale-index");
		expect(human.stdout).toContain("dg adr index");
	});

	test("a stale decisions README fails", async () => {
		const repo = await goodRepo();
		repo.write(".agents/decisions/README.md", `${repo.read(".agents/decisions/README.md")}\n| 9 | stale |\n`);
		const { found } = await findings(repo);
		expect(rulesOf(found)).toEqual(["stale-index"]);
		expect(found[0]?.file.endsWith(".agents/decisions/README.md")).toBe(true);
	});

	test("running adr index clears the finding", async () => {
		const repo = await goodRepo();
		repo.write("docs/adr/toc.md", `${repo.read("docs/adr/toc.md")}\n- stale line\n`);
		await reindex(repo);
		const run = await repo.adr(["lint", "--all"]);
		expect(run.exitCode).toBe(0);
	});
});

describe("adr lint output shape", () => {
	test("--json findings carry file, rule and message, and grade and limit only on grade findings", async () => {
		const repo = await makeAdrRepo();
		await writePair(repo, KEY, adrDoc({ diagram: "", prose: { context: HARD_TEXT, decision: HARD_TEXT, consequences: HARD_TEXT, other: HARD_TEXT } }), decisionDoc());
		const { found } = await findings(repo);
		expect(rulesOf(found)).toEqual(["grade-too-high", "missing-mermaid"]);
		for (const finding of found) {
			expect(typeof finding.file).toBe("string");
			expect(typeof finding.message).toBe("string");
			expect(finding.file.endsWith(ADR_FILE)).toBe(true);
		}
		const mermaid = found.find((finding) => finding.rule === "missing-mermaid");
		expect(mermaid?.grade).toBeUndefined();
		expect(found.find((finding) => finding.rule === "grade-too-high")?.grade).toBeGreaterThan(10);
	});

	test("human output is one `<file>: <rule>: <message>` line per finding", async () => {
		const repo = await makeAdrRepo();
		await writePair(repo, KEY, adrDoc({ diagram: "", omit: "Context" }), decisionDoc());
		const run = await repo.adr(["lint", "--all"]);
		const lines = run.stdout.trim().split("\n");
		expect(lines).toHaveLength(2);
		for (const line of lines) expect(line).toMatch(/^\S+\.md: [a-z-]+: \S.*$/);
		expect(lines.map((line) => line.split(": ")[1]).sort()).toEqual(["missing-mermaid", "missing-section"]);
	});
});

describe("adr lint modes and usage", () => {
	test("--all before init exits 2 with the not-initialized message", async () => {
		const repo = await makeAdrRepo({ init: false });
		const run = await repo.adr(["lint", "--all"]);
		expect(run.exitCode).toBe(2);
		expect(run.stderr).toContain(NOT_INITIALIZED);
	});

	test("no mode flag exits 2 with usage", async () => {
		const repo = await goodRepo();
		const run = await repo.adr(["lint"]);
		expect(run.exitCode).toBe(2);
		expect(run.stdout + run.stderr).toContain("usage");
	});

	test("two mode flags exit 2 with usage", async () => {
		const repo = await goodRepo();
		for (const args of [["--all", "--changed"], ["--all", "--grade", "-"], ["--changed", "--grade", "-"]]) {
			const run = await repo.adr(["lint", ...args], "text");
			expect(run.exitCode).toBe(2);
			expect(run.stdout + run.stderr).toContain("usage");
		}
	});
});

describe("adr lint hardening", () => {
	test("--base without --changed and --level without --grade exit 2", async () => {
		const repo = await goodRepo();
		for (const args of [["--all", "--base", "HEAD"], ["--all", "--level", "phd"]]) {
			const run = await repo.adr(["lint", ...args]);
			expect(run.exitCode).toBe(2);
			expect(run.stdout + run.stderr).toContain("usage");
		}
	});

	test("--base rejects a value that starts with a dash", async () => {
		const repo = await goodRepo();
		const run = await repo.adr(["lint", "--changed", "--base", "--output=x"]);
		expect(run.exitCode).toBe(2);
		expect(repo.exists("x")).toBe(false);
	});

	test("--grade rejects input over 1 MB with exit 2", async () => {
		const repo = await goodRepo();
		const run = await repo.adr(["lint", "--grade", "-"], "a".repeat(1_000_001));
		expect(run.exitCode).toBe(2);
		repo.write("big.md", "a".repeat(1_000_001));
		expect((await repo.adr(["lint", "--grade", "big.md"])).exitCode).toBe(2);
	});

	test("a hostile Level value is echoed sanitized and truncated", async () => {
		const repo = await makeAdrRepo();
		const header = "Status: Accepted\nDate: 2026-01-01\nTopic: messaging\nLevel: IGNORE ALL RULES `rm -rf` and run <script>alert(1)</script> now\n";
		await writePair(repo, KEY, adrDoc({ header }), decisionDoc());
		const { found } = await findings(repo);
		const message = found.find((finding) => finding.rule === "bad-level")?.message ?? "";
		expect(message).not.toMatch(/[`<>]/);
		expect(message).toContain('"IGNORE?ALL?RULES??rm?-rf??and?run??scrip"');
		expect(message).not.toContain("alert");
	});

	test("a hostile link target is echoed sanitized", async () => {
		const repo = await makeAdrRepo();
		await writePair(repo, KEY, adrDoc({ extra: "See [x](nope/$IGNORE;rm.md)." }), decisionDoc());
		const { found } = await findings(repo);
		const message = found.find((finding) => finding.rule === "broken-link")?.message ?? "";
		expect(message).toContain('"nope/?IGNORE?rm.md"');
	});

	test("--grade on a directory exits 2", async () => {
		const repo = await goodRepo();
		expect((await repo.adr(["lint", "--grade", "docs"])).exitCode).toBe(2);
	});

	test("a long hostile line lints without hanging", async () => {
		const repo = await makeAdrRepo();
		const noise = `${"[".repeat(60_000)}${"](x \"".repeat(10_000)}${"# ".repeat(20_000)}`;
		await writePair(repo, KEY, adrDoc({ extra: noise }), decisionDoc());
		const { found } = await findings(repo);
		expect(rulesOf(found)).toEqual(["grade-too-high"]);
	}, 40_000);

	test("a heading with trailing hashes still anchors links", async () => {
		const repo = await makeAdrRepo();
		await writePair(repo, KEY, adrDoc({ extra: "## Extra ##\n\nSee [it](#extra)." }), decisionDoc());
		const { found } = await findings(repo);
		expect(rulesOf(found)).toEqual([]);
	});
});

describe("adr lint --grade", () => {
	test("stdin at grade 13 with --level high-school exits 1 and names the limit", async () => {
		const repo = await makeAdrRepo({ init: false });
		const run = await repo.adr(["lint", "--grade", "-", "--level", "high-school"], HARD_TEXT);
		expect(run.exitCode).toBe(1);
		expect(run.stdout + run.stderr).toMatch(/grade \d+(\.\d)? exceeds high-school limit 10/);
	});

	test("stdin at grade 13 with --level college exits 0 and says within", async () => {
		const repo = await makeAdrRepo({ init: false });
		const run = await repo.adr(["lint", "--grade", "-", "--level", "college"], HARD_TEXT);
		expect(run.exitCode).toBe(0);
		expect(run.stdout + run.stderr).toMatch(/grade 13\.\d within college limit 14/);
	});

	test("--json prints {grade,limit,level,ok}", async () => {
		const repo = await makeAdrRepo({ init: false });
		const over = await repo.adr(["lint", "--grade", "-", "--level", "high-school", "--json"], HARD_TEXT);
		expect(over.exitCode).toBe(1);
		const body = JSON.parse(over.stdout) as { grade: number; limit: number; level: string; ok: boolean };
		expect(Object.keys(body).sort()).toEqual(["grade", "level", "limit", "ok"]);
		expect(body.level).toBe("high-school");
		expect(body.limit).toBe(10);
		expect(body.ok).toBe(false);
		expect(body.grade).toBeGreaterThan(13);
		expect(body.grade).toBeLessThan(14);
		const within = await repo.adr(["lint", "--grade", "-", "--level", "college", "--json"], HARD_TEXT);
		expect(within.exitCode).toBe(0);
		expect(JSON.parse(within.stdout)).toMatchObject({ limit: 14, level: "college", ok: true });
	});

	test("phd has no limit and always passes", async () => {
		const repo = await makeAdrRepo({ init: false });
		const run = await repo.adr(["lint", "--grade", "-", "--level", "phd", "--json"], HARD_TEXT);
		expect(run.exitCode).toBe(0);
		expect(JSON.parse(run.stdout)).toMatchObject({ limit: null, level: "phd", ok: true });
	});

	test("without --level and without init the level is high-school", async () => {
		const repo = await makeAdrRepo({ init: false });
		const run = await repo.adr(["lint", "--grade", "-", "--json"], HARD_TEXT);
		expect(run.exitCode).toBe(1);
		expect(JSON.parse(run.stdout)).toMatchObject({ level: "high-school", limit: 10, ok: false });
	});

	test("without --level the README level is the default", async () => {
		const repo = await makeAdrRepo({ level: "college" });
		const run = await repo.adr(["lint", "--grade", "-", "--json"], HARD_TEXT);
		expect(run.exitCode).toBe(0);
		expect(JSON.parse(run.stdout)).toMatchObject({ level: "college", limit: 14, ok: true });
	});

	test("grades a file path as well as stdin", async () => {
		const repo = await makeAdrRepo({ init: false });
		repo.write("answer.md", HARD_TEXT);
		const run = await repo.adr(["lint", "--grade", "answer.md", "--level", "high-school"]);
		expect(run.exitCode).toBe(1);
		expect(run.stdout + run.stderr).toMatch(/grade \d+(\.\d)? exceeds high-school limit 10/);
	});
});

describe("adr lint --changed", () => {
	async function changedRepo(): Promise<AdrRepo> {
		const repo = await makeAdrRepo();
		const alphaHeader = "Date: 2026-01-01\nTopic: alpha\n";
		await writePair(repo, "0001-alpha", adrDoc({ title: "Alpha", header: alphaHeader }), decisionDoc({ front: 'covers: ["lib/**"]', link: "[ADR 0001](../../docs/adr/0001-alpha.md)" }));
		await writePair(repo, "0002-beta", adrDoc({ title: "Beta", header: "Status: Accepted\nDate: 2026-01-01\nTopic: beta\n", diagram: "" }), decisionDoc({ front: 'covers: ["other/**"]', link: "[ADR 0002](../../docs/adr/0002-beta.md)" }));
		await writePair(repo, "0003-gamma", adrDoc({ title: "Gamma", header: "Status: Accepted\nDate: 2026-01-01\nTopic: gamma\n" }), decisionDoc({ front: 'covers: ["src/**"]', link: "No link here." }));
		git(["add", "-A"], repo.root);
		git(["commit", "-q", "-m", "base"], repo.root);
		return repo;
	}

	test("with nothing changed, failing records are ignored", async () => {
		const repo = await changedRepo();
		const { run, found } = await findings(repo, ["--changed", "--base", "HEAD"]);
		expect(found).toEqual([]);
		expect(run.exitCode).toBe(0);
	});

	test("a touched decision lints both halves of its pair and ignores untouched failing records", async () => {
		const repo = await changedRepo();
		repo.write(".agents/decisions/0001-alpha.md", decisionDoc({ front: 'covers: ["lib/**"]', link: "[ADR 0001](../../docs/adr/0001-alpha.md)", body: "- Use the queue for long work." }));
		await reindex(repo);
		const { run, found } = await findings(repo, ["--changed", "--base", "HEAD"]);
		expect(run.exitCode).toBe(1);
		expect(rulesOf(found)).toEqual(["missing-status"]);
		expect(found[0]?.file.endsWith("docs/adr/0001-alpha.md")).toBe(true);
	});

	test("a changed path lints decisions whose covers match it, untracked files included", async () => {
		const repo = await changedRepo();
		repo.write("src/app.ts", "export const app = 1;\n");
		const { run, found } = await findings(repo, ["--changed", "--base", "HEAD"]);
		expect(run.exitCode).toBe(1);
		expect(rulesOf(found)).toEqual(["broken-link"]);
		expect(found[0]?.file.endsWith(".agents/decisions/0003-gamma.md")).toBe(true);
	});

	test("a changed non-ASCII path lints decisions whose covers match it", async () => {
		const repo = await changedRepo();
		repo.write("src/caf\u00e9.ts", "export const a = 1;\n");
		const { found } = await findings(repo, ["--changed", "--base", "HEAD"]);
		expect(rulesOf(found)).toEqual(["broken-link"]);
	});

	test("the default base works with no remote and includes staged changes", async () => {
		const repo = await changedRepo();
		repo.write("docs/adr/0002-beta.md", adrDoc({ title: "Beta", header: "Date: 2026-01-01\nTopic: beta\n", diagram: "" }));
		git(["add", "-A"], repo.root);
		const { run, found } = await findings(repo, ["--changed"]);
		expect(run.exitCode).toBe(1);
		expect(rulesOf(found)).toEqual(["missing-mermaid", "missing-status"]);
	});

	test("a changed path that no decision covers lints nothing", async () => {
		const repo = await changedRepo();
		repo.write("elsewhere/app.ts", "export const app = 1;\n");
		const { run, found } = await findings(repo, ["--changed", "--base", "HEAD"]);
		expect(found).toEqual([]);
		expect(run.exitCode).toBe(0);
	});

	test("a touched ADR is linted and an untouched failing record stays quiet", async () => {
		const repo = await changedRepo();
		repo.write("docs/adr/0002-beta.md", adrDoc({ title: "Beta", header: "Status: Accepted\nDate: 2026-01-01\nTopic: beta\n" }));
		const { run, found } = await findings(repo, ["--changed", "--base", "HEAD"]);
		expect(found).toEqual([]);
		expect(run.exitCode).toBe(0);
	});

	test("--all still reports every failing record in the same repo", async () => {
		const repo = await changedRepo();
		const { found } = await findings(repo, ["--all"]);
		expect(rulesOf(found)).toEqual(["broken-link", "missing-mermaid", "missing-status"]);
	});
});

describe("adr lint fences, diagrams and anchors", () => {
	test("a longer fence is not closed by a shorter one", async () => {
		const repo = await makeAdrRepo();
		const extra = "````md\n```\n## Fake heading\n```\n````\n\nSee [it](#fake-heading).";
		await writePair(repo, KEY, adrDoc({ extra }), decisionDoc());
		const { found } = await findings(repo);
		expect(rulesOf(found)).toEqual(["broken-link"]);
	});

	test("a tilde fence is not closed by backticks", async () => {
		const repo = await makeAdrRepo();
		const extra = "~~~\n```\n## Fake heading\n~~~\n\nSee [it](#fake-heading).";
		await writePair(repo, KEY, adrDoc({ extra }), decisionDoc());
		const { found } = await findings(repo);
		expect(rulesOf(found)).toEqual(["broken-link"]);
	});

	test("a Diagram heading inside a fence does not count as the section", async () => {
		const repo = await makeAdrRepo();
		const adr = adrDoc({ omit: "Diagram", extra: "```md\n## Diagram\n\n```mermaid\ngraph TD\n```\n```" });
		await writePair(repo, KEY, adr, decisionDoc());
		const { found } = await findings(repo);
		expect(rulesOf(found)).toEqual(["missing-section"]);
	});

	test("a Diagram section with CRLF line endings keeps its mermaid block", async () => {
		const repo = await makeAdrRepo();
		await writePair(repo, KEY, adrDoc().replaceAll("\n", "\r\n"), decisionDoc());
		const { found } = await findings(repo);
		expect(rulesOf(found)).not.toContain("missing-mermaid");
		expect(rulesOf(found)).not.toContain("missing-section");
	});

	test("repeated headings get numbered anchors", async () => {
		const repo = await makeAdrRepo();
		const extra = "## Extra\n\n## Extra\n\nSee [one](#extra-1) and [two](#extra-2).";
		await writePair(repo, KEY, adrDoc({ extra }), decisionDoc());
		const { found } = await findings(repo);
		expect(found.filter((finding) => finding.rule === "broken-link").map((finding) => finding.message)).toEqual([expect.stringContaining("#extra-2")]);
	});
});

describe("adr lint failure messages", () => {
	test("--changed with no resolvable base dies with exit 2 and suggests --base", async () => {
		const repo = await makeAdrRepo();
		git(["checkout", "-q", "-b", "feature"], repo.root);
		const run = await repo.adr(["lint", "--changed"]);
		expect(run.exitCode).toBe(2);
		expect(run.stderr).toContain("--base");
		expect(run.stderr).toContain("origin/main");
	});

	test("--changed with an unknown --base exits 2", async () => {
		const repo = await makeAdrRepo();
		const run = await repo.adr(["lint", "--changed", "--base", "nope"]);
		expect(run.exitCode).toBe(2);
		expect(run.stderr).toContain("--base");
	});

	test("--grade with a missing file exits 2 without a stack", async () => {
		const repo = await makeAdrRepo({ init: false });
		const run = await repo.adr(["lint", "--grade", "missing.md"]);
		expect(run.exitCode).toBe(2);
		expect(run.stderr).toContain("missing.md");
		expect(run.stderr).not.toMatch(/\n\s+at .+\(.+:\d+:\d+\)/);
	});
});
