import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReviewThread } from "../src/provider/types";
import { parsePolicy } from "../src/thrash/policy";
import {
	addressFileName,
	annotateDiff,
	compileReview,
	decideVerdict,
	diffStats,
	type Finding,
	LARGE_DIFF_LINES,
	MAX_CHUNKS,
	mergeOutputs,
	NIT_LADDER,
	parseAgentOutput,
	parseSpice,
	parseTier,
	parseUnifiedDiff,
	planChunks,
	renderAddressFile,
	renderTallyTable,
	resolveAnchor,
	SPICE_DEFAULT,
	stackFor,
	TIER_EMOJI,
	type Tier,
	spiceLabel,
	toPostReviewInput,
	VERDICT_LIMITS,
	relativePlanPath,
	resolvePlanPath,
	reviewTrigger,
} from "../src/thrash/core";

const FIXTURE = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 export { a, b };
\x20
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const n = 1;
+export const m = 2;
diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
--- a/src/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export const g = 1;
-export const h = 2;
diff --git a/old/name.ts b/new/name.ts
similarity index 90%
rename from old/name.ts
rename to new/name.ts
--- a/old/name.ts
+++ b/new/name.ts
@@ -1,2 +1,2 @@
 const x = 1;
-const y = 2;
+const y = 3;
diff --git a/img.png b/img.png
Binary files a/img.png and b/img.png differ
`;

const FILES = parseUnifiedDiff(FIXTURE);

function finding(
	path: string,
	line: number | null,
	tier: Tier,
	body = `${tier} body`,
	side: "new" | "old" = "new",
): Finding {
	return { path, line, side, tier, title: `${tier} title`, body };
}

const NO_SWOT = { changed: "", strengths: [], opportunities: [] };

function thread(path: string, line: number, body: string, resolved = false): ReviewThread {
	return {
		threadId: `t-${path}-${line}`,
		resolved,
		comments: [{ id: "1", author: "bot", body, createdAt: "", diffHunk: "" }],
		commentId: "1",
		path,
		line,
	};
}

const NO_OPTS = { spice: SPICE_DEFAULT, commentOnly: false, existing: [] as ReviewThread[] };

describe("parseUnifiedDiff", () => {
	test("numbers context, added, and removed lines on their own sides", () => {
		const a = FILES.find((f) => f.path === "src/a.ts");
		expect(a?.status).toBe("modified");
		expect(a?.lines).toEqual([
			{ kind: "context", oldLine: 1, newLine: 1, text: "const a = 1;" },
			{ kind: "del", oldLine: 2, text: "const b = 2;" },
			{ kind: "add", newLine: 2, text: "const b = 3;" },
			{ kind: "add", newLine: 3, text: "const c = 4;" },
			{ kind: "context", oldLine: 3, newLine: 4, text: "export { a, b };" },
			{ kind: "context", oldLine: 4, newLine: 5, text: "" },
		]);
	});

	test("marks added, deleted, renamed, and binary files with the right paths", () => {
		const byPath = new Map(FILES.map((f) => [f.path, f]));
		expect(byPath.get("src/new.ts")?.status).toBe("added");
		expect(byPath.get("src/gone.ts")?.status).toBe("deleted");
		expect(byPath.get("src/gone.ts")?.lines.map((l) => l.oldLine)).toEqual([1, 2]);
		expect(byPath.get("new/name.ts")?.status).toBe("renamed");
		expect(byPath.get("new/name.ts")?.oldPath).toBe("old/name.ts");
		expect(byPath.get("img.png")?.status).toBe("binary");
		expect(byPath.get("img.png")?.lines).toEqual([]);
	});

	test("does not invent a trailing context line from the final newline", () => {
		const files = parseUnifiedDiff("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n");
		expect(files[0].lines).toHaveLength(2);
	});
});

describe("annotateDiff", () => {
	test("labels old and new line numbers independently", () => {
		const files = parseUnifiedDiff(`diff --git a/src/example.ts b/src/example.ts
--- a/src/example.ts
+++ b/src/example.ts
@@ -4,3 +8,3 @@
 before
-removed
+added
 after
`);

		expect(annotateDiff(files)).toBe(`=== src/example.ts [modified]
old:4 new:8   before
old:5 new:- - removed
old:- new:9 + added
old:6 new:10   after
`);
	});

	test("never renders the annotated text position as a bare line citation", () => {
		const leadingDiff = Array.from(
			{ length: 21 },
			(_, index) => `diff --git a/src/leading-${index}.ts b/src/leading-${index}.ts
--- a/src/leading-${index}.ts
+++ b/src/leading-${index}.ts
@@ -1 +1 @@
 leading ${index}
`,
		).join("");
		const files = parseUnifiedDiff(`${leadingDiff}diff --git a/src/target.ts b/src/target.ts
--- a/src/target.ts
+++ b/src/target.ts
@@ -5 +9 @@
 return target;
`);
		const renderedLines = annotateDiff(files).split("\n");
		const targetIndex = renderedLines.findIndex((line) => line.endsWith("return target;"));
		const renderedPosition = targetIndex + 1;
		const targetLine = renderedLines[targetIndex];

		expect(renderedPosition).toBeGreaterThan(60);
		expect(targetLine).toBe("old:5 new:9   return target;");
		expect(targetLine).not.toMatch(/^\s*\d/);
		expect(targetLine).not.toMatch(new RegExp(`^\\s*${renderedPosition}(?:\\s|$)`));
	});

	test("prints the rename header and the binary-file notice", () => {
		const out = annotateDiff(FILES);
		expect(out).toContain("=== new/name.ts [renamed] (renamed from old/name.ts)");
		expect(out).toContain("binary file, no text diff");
	});
});

describe("diffStats", () => {
	test("counts added and removed lines across every file", () => {
		expect(diffStats(FILES)).toEqual({ files: 5, added: 5, deleted: 4, changed: 9 });
	});
});

describe("resolveAnchor", () => {
	test("an added line anchors on the new side only", () => {
		expect(resolveAnchor(FILES, finding("src/a.ts", 2, "high"))).toEqual({
			path: "src/a.ts",
			oldPath: undefined,
			newLine: 2,
			oldLine: undefined,
		});
	});

	test("a context line carries both numbers so GitLab accepts it", () => {
		expect(resolveAnchor(FILES, finding("src/a.ts", 4, "nit"))).toEqual({
			path: "src/a.ts",
			oldPath: undefined,
			newLine: 4,
			oldLine: 3,
		});
	});

	test("a removed line anchors on the old side only", () => {
		expect(resolveAnchor(FILES, finding("src/a.ts", 2, "medium", "gone", "old"))).toEqual({
			path: "src/a.ts",
			oldPath: undefined,
			oldLine: 2,
			newLine: undefined,
		});
	});

	test("rejects a new-side cite of a line the diff does not contain", () => {
		expect(resolveAnchor(FILES, finding("src/a.ts", 40, "low"))).toBeNull();
		expect(resolveAnchor(FILES, finding("src/missing.ts", 1, "low"))).toBeNull();
		expect(resolveAnchor(FILES, finding("img.png", 1, "low"))).toBeNull();
		expect(resolveAnchor(FILES, finding("src/a.ts", null, "low"))).toBeNull();
	});

	test("a renamed file keeps its old path for the provider position", () => {
		expect(resolveAnchor(FILES, finding("new/name.ts", 2, "low"))).toMatchObject({
			path: "new/name.ts",
			oldPath: "old/name.ts",
			newLine: 2,
		});
	});
});

describe("parseAgentOutput", () => {
	test("reads the last fenced json block and normalizes tiers, sides, and lines", () => {
		const text =
			'Notes first.\n```json\n{"changed":" ok ","strengths":["s",""," "],"opportunities":"none","findings":[{"path":"a","line":"3","tier":"Nitpick","title":" t ","body":" x "}]}\n```\n';
		expect(parseAgentOutput(text)).toEqual({
			changed: "ok",
			strengths: ["s"],
			opportunities: [],
			findings: [{ path: "a", line: 3, side: "new", tier: "nit", title: "t", body: "x" }],
		});
	});

	test("accepts a bare json object and a null line", () => {
		const out = parseAgentOutput('{"findings":[{"path":"a","line":null,"side":"old","tier":"high","body":"b"}]}');
		expect(out).toMatchObject({ changed: "", strengths: [], opportunities: [] });
		expect(out.findings[0]).toMatchObject({ line: null, side: "old", tier: "high", title: "" });
	});

	test("rejects a finding with no body or an unknown tier", () => {
		expect(() => parseAgentOutput('{"findings":[{"path":"a","line":1,"tier":"high","body":""}]}')).toThrow(/body/);
		expect(() => parseAgentOutput('{"findings":[{"path":"a","line":1,"tier":"scary","body":"b"}]}')).toThrow(/tier/);
		expect(() => parseAgentOutput("no json here")).toThrow(/JSON/);
	});
});

describe("decideVerdict", () => {
	const tally = (critical: number, high: number, medium = 0, low = 0) => ({ critical, high, medium, low, nit: 0 });

	test("any critical requests changes at every spice level", () => {
		for (const spice of [1, 2, 3, 4, 5]) {
			expect(decideVerdict(tally(1, 0), spice, false).verdict).toBe("request_changes");
		}
	});

	test("the default spice allows 1 high and requests changes at 2", () => {
		expect(decideVerdict(tally(0, 1), SPICE_DEFAULT, false).verdict).toBe("approve");
		expect(decideVerdict(tally(0, 2), SPICE_DEFAULT, false).verdict).toBe("request_changes");
	});

	test("the thrash skill documents the verdict limits and chunk constants it owns", () => {
		const skill = readFileSync(
			join(import.meta.dir, "../../../plugins/dg/skills/thrash/SKILL.md"),
			"utf8",
		);
		const tiers = ["critical", "high", "medium", "low"] as const;
		const documented: Record<number, Partial<Record<Tier, number>>> = {};
		for (const match of skill.matchAll(/^\| (\d) \|(.*)\|$/gm)) {
			const cells = (match[2] ?? "").split("|").map((cell) => cell.trim());
			const limits: Partial<Record<Tier, number>> = {};
			tiers.forEach((tier, index) => {
				const cell = cells[index];
				if (cell) limits[tier] = Number(cell);
			});
			documented[Number(match[1])] = limits;
		}
		expect(documented).toEqual(VERDICT_LIMITS);
		expect(skill).toContain(`(${LARGE_DIFF_LINES} changed lines)`);
		expect(skill).toContain(`\`MAX_CHUNKS\` (${MAX_CHUNKS})`);
	});

	test("each tier limit passes at the limit and fails one past it", () => {
		for (const [spice, limits] of Object.entries(VERDICT_LIMITS)) {
			for (const [tier, limit] of Object.entries(limits)) {
				if (tier === "critical") continue;
				const at = { ...tally(0, 0), [tier]: limit };
				const over = { ...tally(0, 0), [tier]: limit + 1 };
				expect(decideVerdict(at, Number(spice), false).verdict).toBe("approve");
				expect(decideVerdict(over, Number(spice), false).verdict).toBe("request_changes");
			}
		}
	});

	test.each([
		[1, tally(0, 4), "approve"],
		[1, tally(0, 5), "request_changes"],
		[3, tally(0, 0, 4), "approve"],
		[3, tally(0, 1), "request_changes"],
		[4, tally(0, 0, 2), "approve"],
		[4, tally(0, 0, 3), "request_changes"],
		[5, tally(0, 0, 0, 4), "approve"],
		[5, tally(0, 0, 1), "request_changes"],
	] as const)("spice %i pins the literal limits for %j", (spice, counts, verdict) => {
		expect(decideVerdict(counts, spice, false).verdict).toBe(verdict);
	});

	test("a higher spice fails a diff that a lower spice passes", () => {
		const diff = tally(0, 1, 4);
		expect(decideVerdict(diff, 2, false).verdict).toBe("approve");
		expect(decideVerdict(diff, 4, false).verdict).toBe("request_changes");
	});

	test("the reason names the tier and the spice limit", () => {
		expect(decideVerdict(tally(0, 0, 4), 4, false).reason).toBe("4 medium findings found, limit is 2 at spice 4");
	});

	test("comment-only overrides the rule", () => {
		expect(decideVerdict(tally(3, 3), 5, true).verdict).toBe("comment");
	});
});

describe("reviewTrigger", () => {
	test.each([
		['{"origin":"daemon","backend":"claude"}', "daemon"],
		['{"origin":"manual"}', "manual"],
		["{}", "manual"],
		["not json", "manual"],
		[undefined, "manual"],
	] as const)("reads %p as %s", (context, trigger) => {
		expect(reviewTrigger(context)).toBe(trigger);
	});
});

describe("compileReview", () => {
	test.each([
		["daemon", "**Trigger:** Automatic (daemon)"],
		["manual", "**Trigger:** Manual (CLI)"],
		[undefined, "**Trigger:** Manual (CLI)"],
	] as const)("the body names the %s trigger", (trigger, line) => {
		const review = compileReview(FILES, { ...NO_SWOT, findings: [] }, { ...NO_OPTS, trigger });
		expect(review.body).toContain(line);
	});

	test("posts anchored findings as rendered comments sorted by path and line", () => {
		const review = compileReview(
			FILES,
			{ ...NO_SWOT, findings: [finding("src/new.ts", 1, "low"), finding("src/a.ts", 3, "high", "fix it")] },
			NO_OPTS,
		);
		expect(review.comments.map((c) => [c.path, c.newLine])).toEqual([
			["src/a.ts", 3],
			["src/new.ts", 1],
		]);
		expect(review.comments[0].body).toBe(`${TIER_EMOJI.high} **High** fix it`);
		expect(review.verdict).toBe("approve");
		expect(review.body).toContain('<span title="High">🔥</span> 1 · ');
		expect(review.body).toContain("**Verdict:** Approve.");
	});

	test("the body heads with the spice peppers and renders only the filled sections", () => {
		const review = compileReview(
			FILES,
			{ changed: "Adds a.", strengths: ["Tested."], opportunities: ["Split it.", "Name it."], findings: [] },
			{ ...NO_OPTS, spice: 3 },
		);
		expect(review.body).toStartWith('## Thrash review <span title="Spice 3 of 5">🌶️🌶️🌶️○○</span>\n');
		expect(review.body).toContain("> [!NOTE]\n> **What changed**\n>\n> Adds a.\n");
		expect(review.body).toContain("> [!TIP]\n> **Strengths**\n>\n> Tested.\n");
		expect(review.body).toContain("> [!WARNING]\n> **Opportunities**\n>\n> - Split it.\n> - Name it.\n");
		expect(review.body).not.toContain("### Findings");

		const bare = compileReview(FILES, { ...NO_SWOT, findings: [] }, NO_OPTS);
		expect(bare.body).not.toContain("> [!");
	});

	test("the body lists no posted findings, but names an unanchored one, and counts line and file comments", () => {
		const findings = [
			{ ...finding("src/a.ts", 2, "critical"), title: "line title" },
			{ ...finding("src/a.ts", 99, "medium"), title: "file title" },
			{ ...finding("src/missing.ts", 1, "low"), title: "missing title" },
		];
		const review = compileReview(FILES, { ...NO_SWOT, findings }, { ...NO_OPTS, spice: 5 });
		expect(review.body).not.toContain("### Findings");
		for (const title of ["line title", "file title"]) expect(review.body).not.toContain(title);
		expect(review.body).toContain("· 1 line comment, 1 file comment");
		expect(review.body).toContain("1 finding named no file in this diff and was not posted:\n- 🧹 missing title");
	});

	test("the nit ladder caps posted nits per spice level and folds the rest into the body", () => {
		const nits = Array.from({ length: 25 }, (_, i) => finding("src/a.ts", 1, "nit", `nit ${i}`));
		for (const spice of [1, 2, 3, 4, 5]) {
			const review = compileReview(FILES, { ...NO_SWOT, findings: nits }, { ...NO_OPTS, spice });
			const cap = Math.min(NIT_LADDER[spice], 25);
			expect(review.comments).toHaveLength(cap);
			expect(review.dropped.filter((d) => d.reason === "nit-ladder")).toHaveLength(25 - cap);
			expect(review.tally.nit).toBe(25);
			if (cap < 25) expect(review.body).toContain(`${25} (${25 - cap} folded)`);
			expect(review.body).not.toContain("### Folded nits");
		}
	});

	test("--min-tier overrides the ladder in both directions", () => {
		const findings = [finding("src/a.ts", 1, "nit"), finding("src/a.ts", 2, "low"), finding("src/a.ts", 3, "medium")];
		const onlyMedium = compileReview(FILES, { ...NO_SWOT, findings }, { ...NO_OPTS, spice: 5, minTier: "medium" });
		expect(onlyMedium.comments.map((c) => c.tier)).toEqual(["medium"]);
		expect(onlyMedium.dropped.map((d) => d.reason)).toEqual(["below-min-tier", "below-min-tier"]);

		const unfiltered = compileReview(FILES, { ...NO_SWOT, findings }, { ...NO_OPTS, spice: 5 });
		expect(onlyMedium.tally).toEqual(unfiltered.tally);
		expect(onlyMedium.verdict).toBe(unfiltered.verdict);

		const allNits = compileReview(FILES, { ...NO_SWOT, findings }, { ...NO_OPTS, spice: 1, minTier: "nit" });
		expect(allNits.comments.map((c) => c.tier)).toEqual(["nit", "low", "medium"]);
	});

	test("an explicit --min-tier nit does not lift a policy phase's nit ban", () => {
		const findings = [finding("src/a.ts", 1, "nit"), finding("src/a.ts", 2, "low")];
		const policy = parsePolicy("phases:\n  - nits: false\n");
		const review = compileReview(FILES, { ...NO_SWOT, findings }, { ...NO_OPTS, spice: 5, policy, minTier: "nit" });
		expect(review.comments.map((c) => c.tier)).toEqual(["low"]);
		expect(review.dropped.map((d) => d.reason)).toEqual(["below-min-tier"]);
	});

	test("a stricter --min-tier still wins over a policy phase that allows nits", () => {
		const findings = [finding("src/a.ts", 1, "low"), finding("src/a.ts", 2, "medium")];
		const policy = parsePolicy("phases:\n  - nits: true\n");
		const review = compileReview(FILES, { ...NO_SWOT, findings }, { ...NO_OPTS, spice: 5, policy, minTier: "medium" });
		expect(review.comments.map((c) => c.tier)).toEqual(["medium"]);
	});

	test("skips a line that already carries an open thrash thread but still counts it", () => {
		const existing = [
			thread("src/a.ts", 2, `${TIER_EMOJI.high} **High** earlier`),
			thread("src/a.ts", 3, `${TIER_EMOJI.high} **High** resolved`, true),
			thread("src/new.ts", 1, "human comment, not thrash"),
		];
		const findings = [
			finding("src/a.ts", 2, "critical"),
			finding("src/a.ts", 3, "high"),
			finding("src/new.ts", 1, "high"),
		];
		const review = compileReview(FILES, { ...NO_SWOT, findings }, { ...NO_OPTS, existing });
		expect(review.comments.map((c) => [c.path, c.newLine])).toEqual([
			["src/a.ts", 3],
			["src/new.ts", 1],
		]);
		expect(review.dropped).toEqual([{ finding: findings[0], reason: "duplicate" }]);
		expect(review.tally.critical).toBe(1);
		expect(review.verdict).toBe("request_changes");
		expect(review.body).toContain("1 finding already flagged");
	});

	test("an outdated resolved thread does not settle a new finding at its old line", () => {
		const outdated: ReviewThread = {
			...thread("src/a.ts", 2, `${TIER_EMOJI.medium} **Medium** old`, true),
			line: null,
			originalLine: 2,
		};
		const findings = [finding("src/a.ts", 2, "medium")];
		const review = compileReview(FILES, { ...NO_SWOT, findings }, { ...NO_OPTS, existing: [outdated] });
		expect(review.comments.map((c) => [c.path, c.newLine])).toEqual([["src/a.ts", 2]]);
		expect(review.dropped).toEqual([]);
	});

	test("an outdated resolved thread leaves a new medium finding unsettled in the policy tally", () => {
		const outdated: ReviewThread = {
			...thread("src/a.ts", 2, `${TIER_EMOJI.medium} **Medium** old`, true),
			line: null,
			originalLine: 2,
		};
		const findings = [finding("src/a.ts", 2, "medium")];
		const policy = parsePolicy("phases:\n  - block:\n      medium: 0\n");
		const review = compileReview(FILES, { ...NO_SWOT, findings }, { ...NO_OPTS, existing: [outdated], policy });
		expect(review.comments.map((c) => [c.path, c.newLine])).toEqual([["src/a.ts", 2]]);
		expect(review.tally.medium).toBe(1);
		expect(review.verdict).toBe("request_changes");
	});

	test("a finding with no usable line becomes a file comment; one with no file in the diff is not posted but still counts", () => {
		const findings = [finding("", null, "critical", "cross-file race"), finding("src/a.ts", 99, "medium")];
		const review = compileReview(FILES, { ...NO_SWOT, findings }, NO_OPTS);
		expect(review.comments.map((c) => [c.path, c.newLine, c.oldLine])).toEqual([["src/a.ts", undefined, undefined]]);
		expect(review.unanchored.map((f) => f.body)).toEqual(["cross-file race"]);
		expect(review.verdict).toBe("request_changes");
		expect(review.body).not.toContain("cross-file race");
		expect(review.body).not.toContain("Findings without a line anchor");
	});

	test("a file comment is not reposted over an open thrash file thread", () => {
		const existing = [{ ...thread("src/a.ts", 0, `${TIER_EMOJI.medium} **Medium** earlier`), line: null }];
		const findings = [finding("src/a.ts", null, "medium")];
		const review = compileReview(FILES, { ...NO_SWOT, findings }, { ...NO_OPTS, existing });
		expect(review.comments).toHaveLength(0);
		expect(review.dropped).toEqual([{ finding: findings[0], reason: "duplicate" }]);
	});

	test("nit capping at different spice levels retains a critical verdict", () => {
		const findings = [
			finding("src/a.ts", 1, "critical"),
			...Array.from({ length: 3 }, (_, i) => finding("src/a.ts", 2, "high", `h${i}`)),
			...Array.from({ length: 30 }, (_, i) => finding("src/a.ts", 3, "nit", `n${i}`)),
		];
		const mild = compileReview(FILES, { ...NO_SWOT, findings }, { ...NO_OPTS, spice: 1 });
		const hot = compileReview(FILES, { ...NO_SWOT, findings }, { ...NO_OPTS, spice: 5 });
		expect(mild.verdict).toBe(hot.verdict);
		expect(mild.reason).toBe(hot.reason);
		expect(mild.tally).toEqual(hot.tally);
		expect(mild.comments.length).toBeLessThan(hot.comments.length);
	});

	test("toPostReviewInput drops the tier and keeps provider fields", () => {
		const review = compileReview(FILES, { ...NO_SWOT, findings: [finding("src/a.ts", 4, "low")] }, NO_OPTS);
		expect(toPostReviewInput(review)).toEqual({
			verdict: "approve",
			body: review.body,
			comments: [
				{ path: "src/a.ts", oldPath: undefined, newLine: 4, oldLine: 3, body: `${TIER_EMOJI.low} **Low** low body` },
			],
		});
	});
});

describe("local review file", () => {
	test("renders one /address section per posted comment with the mapped severity", () => {
		const findings = [
			finding("src/a.ts", 2, "critical", "c"),
			finding("src/a.ts", 3, "nit", "n"),
			finding("src/a.ts", null, "high", "h"),
		];
		const review = compileReview(FILES, { ...NO_SWOT, findings }, { ...NO_OPTS, spice: 5 });
		const file = renderAddressFile(review);
		expect(file).toContain(`## src/a.ts:2\n\nseverity: high\n\n${TIER_EMOJI.critical} **Critical** c\n`);
		expect(file).toContain(`## src/a.ts:3\n\nseverity: low\n\n${TIER_EMOJI.nit} **Nit** n\n`);
		expect(file).toContain(`## src/a.ts (whole file)\n\nseverity: high\n\n${TIER_EMOJI.high} **High** h\n`);
	});

	test("file names match the YYYY-MM-DD-HHMMSS-NNN.md glob", () => {
		expect(addressFileName(new Date(2026, 8, 22, 7, 5, 9), 1)).toBe("2026-09-22-070509-001.md");
	});
});

describe("stackFor", () => {
	const pr = (number: number, headRefName: string, baseRefName: string) => ({ number, headRefName, baseRefName });
	const OPEN = [
		pr(30, "c", "b"),
		pr(10, "a", "main"),
		pr(99, "other", "main"),
		pr(20, "b", "a"),
		pr(25, "b2", "a"),
		pr(40, "d", "c"),
	];

	test("walks down to the root and up through every child, parents first", () => {
		const expected = [10, 20, 30, 40, 25];
		for (const start of [10, 30, 40, 25]) {
			expect(stackFor(OPEN, start).map((p) => p.number)).toEqual(expected);
		}
	});

	test("a PR with no stacked neighbors is a stack of one", () => {
		expect(stackFor(OPEN, 99).map((p) => p.number)).toEqual([99]);
	});

	test("a base cycle stops instead of looping", () => {
		expect(stackFor([pr(1, "x", "y"), pr(2, "y", "x")], 1).map((p) => p.number)).toEqual([2, 1]);
	});

	test("a number not in the list throws", () => {
		expect(() => stackFor(OPEN, 7)).toThrow("#7 is not in the list of pull requests");
	});

	const st = (number: number, headRefName: string, baseRefName: string, state: "OPEN" | "MERGED" | "CLOSED") => ({
		number,
		headRefName,
		baseRefName,
		state,
	});

	test("a merged PR mid-stack keeps the chain joined, so the open child is found from the root", () => {
		const prs = [st(1, "a", "main", "OPEN"), st(2, "b", "a", "MERGED"), st(3, "c", "b", "OPEN")];
		for (const start of [1, 2, 3]) {
			expect(stackFor(prs, start).map((p) => p.number)).toEqual([1, 2, 3]);
		}
	});

	test("an open PR owns a reused branch name over an older merged or newer closed one", () => {
		const prs = [
			st(5, "feature", "main", "MERGED"),
			st(8, "feature", "main", "OPEN"),
			st(9, "feature", "main", "CLOSED"),
			st(10, "next", "feature", "OPEN"),
		];
		expect(stackFor(prs, 10).map((p) => p.number)).toEqual([8, 10]);
	});

	test("without an open owner, the newest PR owns a reused branch name, whatever the input order", () => {
		const merged5 = st(5, "feature", "main", "MERGED");
		const merged7 = st(7, "feature", "main", "MERGED");
		const child = st(10, "next", "feature", "OPEN");
		expect(stackFor([merged5, merged7, child], 10).map((p) => p.number)).toEqual([7, 10]);
		expect(stackFor([merged7, merged5, child], 10).map((p) => p.number)).toEqual([7, 10]);
	});

	test("a PR without a state counts as open and owns its branch over a newer merged one", () => {
		const legacy = { number: 3, headRefName: "feature", baseRefName: "main" };
		const prs = [st(9, "feature", "main", "MERGED"), legacy, st(10, "next", "feature", "OPEN")];
		expect(stackFor(prs, 10).map((p) => p.number)).toEqual([3, 10]);
		const reversed = [legacy, st(9, "feature", "main", "MERGED"), st(10, "next", "feature", "OPEN")];
		expect(stackFor(reversed, 10).map((p) => p.number)).toEqual([3, 10]);
	});

	test("an open PR owns its branch over a newer merged one listed after it", () => {
		const prs = [st(3, "feature", "main", "OPEN"), st(9, "feature", "main", "MERGED"), st(10, "next", "feature", "OPEN")];
		expect(stackFor(prs, 10).map((p) => p.number)).toEqual([3, 10]);
	});

	test("children stay in number order whatever their state", () => {
		const prs = [st(1, "a", "main", "OPEN"), st(2, "b", "a", "OPEN"), st(3, "c", "a", "CLOSED"), st(4, "d", "a", "MERGED")];
		expect(stackFor(prs, 1).map((p) => p.number)).toEqual([1, 2, 3, 4]);
	});
});

describe("renderTallyTable", () => {
	const review = compileReview(
		FILES,
		{ ...NO_SWOT, findings: [finding("src/a.ts", 3, "high"), finding("src/new.ts", 1, "nit")] },
		NO_OPTS,
	);
	const target = "https://github.com/acme/widgets/pull/12";

	test("a posted row links the review and shows the accepted verdict", () => {
		const table = renderTallyTable([
			{ target, review, posted: { url: `${target}#r1`, verdict: "approve", degraded: false, commentCount: 2 } },
		]);
		expect(table).toContain("| PR | Link | 💀 | 🔥 | ⚠️ | 🧹 | 🔬 | Comments | Verdict |");
		expect(table).toContain(`| #12 | [review](${target}#r1) | 0 | 1 | 0 | 0 | 1 | 2 | Approve |`);
	});

	test("a degraded post names the refused verdict", () => {
		const posted = { url: `${target}#r1`, verdict: "comment" as const, degraded: true, commentCount: 2 };
		expect(renderTallyTable([{ target, review, posted }])).toContain("| Comment (approve refused) |");
	});

	test("stack status rows say merged context or closed, with no counts", () => {
		const table = renderTallyTable([
			{ target, stackState: "merged" },
			{ target: target.replace("12", "13"), stackState: "closed" },
		]);
		expect(table.split("\n")[1]).toBe(`|${" --- |".repeat(9)}`);
		expect(table).toContain(`| #12 | [PR](${target}) | - | - | - | - | - | - | merged (context only, not reviewed) |`);
		expect(table).toContain("| #13 |");
		expect(table).toContain("| closed without merging (not reviewed) |");
	});

	test("an unposted row links the PR and says so", () => {
		expect(renderTallyTable([{ target, review }])).toContain(`| #12 | [PR](${target}) |`);
		expect(renderTallyTable([{ target, review }])).toContain("| Approve (not posted) |");
	});
});

describe("flag parsing", () => {
	test("spiceLabel fills one pepper per level and pads to the max with circles", () => {
		expect(spiceLabel(1)).toBe("🌶️○○○○");
		expect(spiceLabel(5)).toBe("🌶️🌶️🌶️🌶️🌶️");
	});

	test("spice defaults and bounds", () => {
		expect(parseSpice(undefined)).toBe(SPICE_DEFAULT);
		expect(parseSpice("5")).toBe(5);
		expect(() => parseSpice("0")).toThrow(/--spice/);
		expect(() => parseSpice("2.5")).toThrow(/--spice/);
	});

	test("tier names are case-insensitive", () => {
		expect(parseTier("HIGH")).toBe("high");
		expect(() => parseTier("blocker")).toThrow(/unknown tier/);
	});
});

function addedFile(path: string, count: number): string {
	const adds = Array.from({ length: count }, (_, i) => `+${path} line ${i}`).join("\n");
	return `diff --git a/${path} b/${path}\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${count} @@\n${adds}\n`;
}

function bigDiff(entries: Array<[string, number]>) {
	return parseUnifiedDiff(entries.map(([path, count]) => addedFile(path, count)).join(""));
}

describe("planChunks", () => {
	test("keeps a diff at the limit in one chunk", () => {
		const plan = planChunks(bigDiff([["src/a.ts", LARGE_DIFF_LINES]]));
		expect(plan.chunks.map((c) => c.label)).toEqual(["whole diff"]);
	});

	test("groups by directory and never splits a file that fits", () => {
		const plan = planChunks(
			bigDiff([
				["api/a.ts", 2000],
				["api/b.ts", 2000],
				["web/c.ts", 1000],
				["web/d.ts", 1000],
			]),
		);
		expect(plan.chunks.map((c) => c.files.map((f) => f.path))).toEqual([
			["api/a.ts"],
			["api/b.ts"],
			["web/c.ts", "web/d.ts"],
		]);
		expect(plan.chunks.every((c) => c.changed <= LARGE_DIFF_LINES)).toBe(true);
	});

	test("cuts a single oversize file by hunks", () => {
		const hunks = [0, 1, 2, 3].map((n) => {
			const adds = Array.from({ length: 1000 }, (_, i) => `+h${n} ${i}`).join("\n");
			return `@@ -${n * 10 + 1},0 +${n * 2000 + 1},1000 @@\n${adds}`;
		});
		const files = parseUnifiedDiff(`diff --git a/big.ts b/big.ts\n--- a/big.ts\n+++ b/big.ts\n${hunks.join("\n")}\n`);
		const plan = planChunks(files);
		expect(plan.chunks.map((c) => c.changed)).toEqual([3000, 1000]);
		expect(plan.chunks.every((c) => c.files.every((f) => f.path === "big.ts"))).toBe(true);
	});

	test("orders source before tests and docs, and gives generated files one chunk", () => {
		const plan = planChunks(
			bigDiff([
				["README.md", 2000],
				["src/app.ts", 2000],
				["src/app.test.ts", 2000],
				["pnpm-lock.yaml", 2000],
				["yarn.lock", 2000],
			]),
		);
		expect(plan.chunks.map((c) => c.label.split(":")[0])).toEqual(["source", "test", "docs", "generated"]);
		expect(plan.skipped).toEqual(["yarn.lock"]);
	});

	test("merges neighbors past the cap so every file is reviewed", () => {
		const entries = Array.from({ length: 12 }, (_, i) => [`m${String(i).padStart(2, "0")}/f.ts`, 2000] as [string, number]);
		const plan = planChunks(bigDiff(entries));
		expect(plan.chunks).toHaveLength(MAX_CHUNKS);
		expect(plan.chunks.flatMap((c) => c.files.map((f) => f.path)).sort()).toEqual(entries.map(([p]) => p));
		expect(plan.skipped).toEqual([]);
		expect(plan.chunks.map((c) => c.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
	});

	test("merges within a category before mixing categories", () => {
		const plan = planChunks(
			bigDiff([
				["a/f.ts", 2000],
				["b/f.ts", 2000],
				["c/f.ts", 2000],
				["d/f.ts", 2000],
				["e/f.ts", 2000],
				["f/f.ts", 2000],
				["g/f.ts", 2000],
				["h/f.ts", 2000],
				["a/f.test.ts", 2000],
				["README.md", 2000],
			]),
		);
		expect(plan.chunks).toHaveLength(MAX_CHUNKS);
		expect(plan.chunks.filter((c) => c.label.startsWith("mixed"))).toHaveLength(0);
		expect(plan.chunks.some((c) => c.label.startsWith("test"))).toBe(true);
		expect(plan.chunks.some((c) => c.label.startsWith("docs"))).toBe(true);
	});
});

describe("mergeOutputs", () => {
	const dup = { path: "a.ts", line: 3, side: "new" as const, tier: "low" as const, title: "", body: "Rename `x`." };

	test("drops the same finding reported twice and keeps the higher tier", () => {
		const merged = mergeOutputs([
			{ changed: "one", strengths: ["Clear."], opportunities: ["Test it."], findings: [dup] },
			{
				changed: "two",
				strengths: ["clear. ", "Small."],
				opportunities: [],
				findings: [
					{ ...dup, tier: "medium", body: "rename  `X`." },
					{ ...dup, line: 4 },
				],
			},
		]);
		expect(merged.findings.map((f) => [f.line, f.tier])).toEqual([
			[3, "medium"],
			[4, "low"],
		]);
		expect(merged.changed).toBe("Chunk 1: one Chunk 2: two");
		expect(merged.strengths).toEqual(["Clear.", "Small."]);
		expect(merged.opportunities).toEqual(["Test it."]);
	});
});

describe("compileReview body", () => {
	test("has no coverage section, so a split review reads like a single one", () => {
		const review = compileReview(FILES, { ...NO_SWOT, findings: [{ ...finding("src/a.ts", 2, "critical") }] }, NO_OPTS);
		expect(review.verdict).toBe("request_changes");
		expect(review.body).not.toContain("### Review coverage");
	});
});

describe("plan paths", () => {
	test("resolvePlanPath joins a relative path to the plan folder", () => {
		expect(resolvePlanPath("/scratch/a", "x.findings.md")).toBe("/scratch/a/x.findings.md");
		expect(resolvePlanPath("/scratch/a/", "sub/x.md")).toBe("/scratch/a/sub/x.md");
	});

	test("resolvePlanPath accepts an absolute path inside the folder", () => {
		expect(resolvePlanPath("/scratch/a", "/scratch/a/x.md")).toBe("/scratch/a/x.md");
	});

	test("resolvePlanPath refuses escapes with distinct messages", () => {
		expect(() => resolvePlanPath("/scratch/a", "/scratch/b/x.md")).toThrow(
			"plan path /scratch/b/x.md is outside the plan folder /scratch/a; the plan predates relative paths or was copied, so run thrash diff again",
		);
		expect(() => resolvePlanPath("/scratch/a", "../b/x.md")).toThrow(
			"plan path ../b/x.md escapes the plan folder /scratch/a",
		);
		expect(() => resolvePlanPath("/scratch/a", "..")).toThrow("escapes the plan folder");
		expect(() => resolvePlanPath("/scratch/a", ".")).toThrow("escapes the plan folder");
		expect(() => resolvePlanPath("/scratch/a", "/scratch/a")).toThrow("is outside the plan folder");
	});

	test("resolvePlanPath allows a file whose name starts with two dots", () => {
		expect(resolvePlanPath("/scratch/a", "..x.md")).toBe("/scratch/a/..x.md");
	});

	test("relativePlanPath stores a path inside the folder and refuses one outside", () => {
		expect(relativePlanPath("/scratch/a", "/scratch/a/x.md")).toBe("x.md");
		expect(() => relativePlanPath("/scratch/a", "/scratch/b/x.md")).toThrow("escapes the plan folder");
	});
});

describe("thrash review hardening", () => {
	test("parseUnifiedDiff reads git-quoted non-ASCII paths", () => {
		const diff = [
			'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"',
			"index 1111111..2222222 100644",
			'--- "a/caf\\303\\251.ts"',
			'+++ "b/caf\\303\\251.ts"',
			"@@ -1,2 +1,2 @@",
			" const x = 1;",
			"-const y = 2;",
			"+const y = 3;",
			"diff --git a/plain.ts b/plain.ts",
			"--- a/plain.ts",
			"+++ b/plain.ts",
			"@@ -1 +1 @@",
			"-a",
			"+b",
			"",
		].join("\n");
		const files = parseUnifiedDiff(diff);
		expect(files.map((f) => f.path)).toEqual(["café.ts", "plain.ts"]);
		expect(files[0].lines.filter((l) => l.kind === "add")).toMatchObject([
			{ newLine: 2, text: "const y = 3;" },
		]);
		expect(files[1].lines.filter((l) => l.kind === "add")).toMatchObject([{ newLine: 1, text: "b" }]);
	});

	test("nits that are unanchored do not use up the nit ladder", () => {
		const findings = [
			...Array.from({ length: 5 }, (_, i) => finding(`nowhere/${i}.ts`, 1, "nit", `lost ${i}`)),
			finding("src/a.ts", 3, "nit", "kept"),
		];
		const review = compileReview(FILES, { ...NO_SWOT, findings }, { ...NO_OPTS, spice: 2 });
		expect(review.comments.map((c) => c.body)).toEqual([`${TIER_EMOJI.nit} **Nit** kept`]);
		expect(review.unanchored).toHaveLength(5);
		expect(review.dropped).toEqual([]);
	});

	test("findings sort by code point, not locale", () => {
		const findings = [finding("a_b.ts", 1, "low"), finding("a-b.ts", 1, "low")];
		const review = compileReview(FILES, { ...NO_SWOT, findings }, NO_OPTS);
		expect(review.unanchored.map((f) => f.path)).toEqual(["a-b.ts", "a_b.ts"]);
	});
});
