import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReviewSummary, ReviewThread } from "../src/provider/types";
import { parsePolicy } from "../src/thrash/policy";
import {
	addressFileName,
	annotateDiff,
	compileReview,
	decideVerdict,
	diffStats,
	emptyTally,
	type Finding,
	LARGE_DIFF_LINES,
	MAX_CHUNKS,
	mergeOutputs,
	NIT_LADDER,
	openPriorTally,
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
	renderComment,
	renderInlineBody,
	reviewTrigger,
	classPrCounts,
	lastReviewedSha,
	parseClassMarker,
	parseUnpostedMarker,
	parseClearedMarker,
	clearedThreadIds,
} from "../src/thrash/core";
import {
	THRASH_CLASSES_MARKER_PREFIX,
	THRASH_CLEARED_MARKER_PREFIX,
	THRASH_REVIEW_MARKER,
	THRASH_UNPOSTED_MARKER_PREFIX,
} from "../src/thrash/constants";

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

function sidedThread(side: "LEFT" | "RIGHT", line: number, body: string, resolved = false): ReviewThread {
	return { ...thread("src/a.ts", line, body, resolved), threadId: `t-${side}-${line}`, side };
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
		expect(decideVerdict(tally(0, 0, 4), 4, false).reason).toBe("4 medium findings are open, limit is 2 at spice 4");
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
		expect(review.comments[0].body).toBe(`${TIER_EMOJI.high} **High** fix it\n\n<!-- dg:thrash-finding "high title" -->`);
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
		expect(review.body).toContain("> [!NOTE]\n> **What changed**\n>\n> - Adds a.\n");
		expect(review.body).toContain("> [!TIP]\n> **Strengths**\n>\n> - Tested.\n");
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

	test("counts a LEFT and a RIGHT high finding on the same line number separately under a policy", () => {
		const findings = [finding("src/a.ts", 2, "high", "removed", "old"), finding("src/a.ts", 2, "high", "added", "new")];
		const existing = [
			sidedThread("LEFT", 2, `${TIER_EMOJI.high} **High** left`),
			sidedThread("RIGHT", 2, `${TIER_EMOJI.high} **High** right`),
		];
		const policy = parsePolicy("phases:\n  - block:\n      high: 1\n");
		const review = compileReview(FILES, { ...NO_SWOT, findings }, { ...NO_OPTS, existing, policy });
		expect(review.tally.high).toBe(2);
		expect(review.verdict).toBe("request_changes");
	});

	test("pairs each high finding with only the thread on its own diff side", () => {
		const findings = [finding("src/a.ts", 2, "high", "removed", "old"), finding("src/a.ts", 2, "high", "added", "new")];
		const policy = parsePolicy("phases:\n  - block:\n      high: 1\n");
		const left = [sidedThread("LEFT", 2, `${TIER_EMOJI.high} **High** left`)];
		const review = compileReview(FILES, { ...NO_SWOT, findings }, { ...NO_OPTS, existing: left, policy });
		expect(review.tally.high).toBe(2);
		expect(review.dropped.map((d) => d.finding.side)).toEqual(["old"]);
	});

	test("a resolved thread on removed code does not settle a new medium finding on the added line at the same number", () => {
		const existing = [sidedThread("LEFT", 2, `${TIER_EMOJI.medium} **Medium** old`, true)];
		const findings = [finding("src/a.ts", 2, "medium")];
		const policy = parsePolicy("phases:\n  - block:\n      medium: 0\n");
		const review = compileReview(FILES, { ...NO_SWOT, findings }, { ...NO_OPTS, existing, policy });
		expect(review.comments.map((c) => [c.path, c.newLine])).toEqual([["src/a.ts", 2]]);
		expect(review.dropped).toEqual([]);
		expect(review.tally.medium).toBe(1);
		expect(review.verdict).toBe("request_changes");
	});

	test("a resolved thread on the same diff side still settles a medium finding", () => {
		const existing = [sidedThread("RIGHT", 2, `${TIER_EMOJI.medium} **Medium** old`, true)];
		const findings = [finding("src/a.ts", 2, "medium")];
		const review = compileReview(FILES, { ...NO_SWOT, findings }, { ...NO_OPTS, existing });
		expect(review.dropped.map((d) => d.reason)).toEqual(["settled"]);
	});

	test("approves in a strict round when no finding is open", () => {
		const policy = parsePolicy(
			"phases:\n  - name: strict\n    through: 1\n    block: { critical: 0, high: 0, medium: 0 }\n  - name: relaxed\n    block: { high: 1 }\n",
		);
		const review = compileReview(FILES, { ...NO_SWOT, findings: [] }, { ...NO_OPTS, policy, round: 1 });
		expect(review.phase).toBe("strict");
		expect(review.verdict).toBe("approve");
	});

	test("approves when earlier blocking findings are now resolved or answered", () => {
		const answered: ReviewThread = {
			...thread("src/a.ts", 3, `${TIER_EMOJI.critical} **Critical** earlier`),
			comments: [
				{ id: "1", author: "bot", body: `${TIER_EMOJI.critical} **Critical** earlier`, createdAt: "", diffHunk: "" },
				{ id: "2", author: "dev", body: "explained", createdAt: "", diffHunk: "" },
			],
		};
		const existing = [thread("src/a.ts", 2, `${TIER_EMOJI.high} **High** earlier`, true), answered];
		const policy = parsePolicy("phases:\n  - name: strict\n    block: { critical: 0, high: 0 }\n");
		const review = compileReview(FILES, { ...NO_SWOT, findings: [] }, { ...NO_OPTS, existing, policy, round: 1 });
		expect(review.tally.critical).toBe(0);
		expect(review.tally.high).toBe(0);
		expect(review.verdict).toBe("approve");
	});

	test("requests changes in a strict round when an earlier high finding is still open", () => {
		const existing = [thread("src/a.ts", 2, `${TIER_EMOJI.high} **High** earlier`)];
		const policy = parsePolicy(
			"phases:\n  - name: strict\n    through: 1\n    block: { high: 0 }\n  - name: relaxed\n    block: { high: 1 }\n",
		);
		const review = compileReview(FILES, { ...NO_SWOT, findings: [] }, { ...NO_OPTS, existing, policy, round: 1 });
		expect(review.verdict).toBe("request_changes");
	});

	test("approves without a policy when earlier blocking findings are fixed and none is re-found", () => {
		const existing = [thread("src/a.ts", 2, `${TIER_EMOJI.critical} **Critical** earlier`, true)];
		const review = compileReview(FILES, { ...NO_SWOT, findings: [] }, { ...NO_OPTS, existing });
		expect(review.verdict).toBe("approve");
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

	test("an outdated resolved thread does not settle a new whole-file finding on its path", () => {
		const outdated: ReviewThread = {
			...thread("src/a.ts", 2, `${TIER_EMOJI.medium} **Medium** old`, true),
			line: null,
			originalLine: 2,
		};
		const findings = [finding("src/a.ts", null, "medium")];
		const review = compileReview(FILES, { ...NO_SWOT, findings }, { ...NO_OPTS, existing: [outdated] });
		expect(review.comments.map((c) => c.path)).toEqual(["src/a.ts"]);
		expect(review.dropped).toEqual([]);
	});

	test("an outdated resolved thread leaves a new whole-file medium finding in the policy tally", () => {
		const outdated: ReviewThread = {
			...thread("src/a.ts", 2, `${TIER_EMOJI.medium} **Medium** old`, true),
			line: null,
			originalLine: 2,
		};
		const findings = [finding("src/a.ts", null, "medium")];
		const policy = parsePolicy("phases:\n  - block:\n      medium: 0\n");
		const review = compileReview(FILES, { ...NO_SWOT, findings }, { ...NO_OPTS, existing: [outdated], policy });
		expect(review.tally.medium).toBe(1);
		expect(review.verdict).toBe("request_changes");
	});

	test("an unresolved outdated thread does not absorb a separate whole-file finding in the policy tally", () => {
		const outdated: ReviewThread = {
			...thread("src/a.ts", 2, `${TIER_EMOJI.medium} **Medium** old`),
			line: null,
			originalLine: 2,
		};
		const findings = [finding("src/a.ts", null, "medium")];
		const policy = parsePolicy("phases:\n  - block:\n      medium: 1\n");
		const review = compileReview(FILES, { ...NO_SWOT, findings }, { ...NO_OPTS, existing: [outdated], policy });
		expect(review.tally.medium).toBe(2);
	});

	test("an explicit outdated flag keeps a thread from matching a whole-file finding", () => {
		const flagged: ReviewThread = { ...thread("src/a.ts", 0, `${TIER_EMOJI.medium} **Medium** old`), line: null, outdated: true };
		const findings = [finding("src/a.ts", null, "medium")];
		const review = compileReview(FILES, { ...NO_SWOT, findings }, { ...NO_OPTS, existing: [flagged] });
		expect(review.comments).toHaveLength(1);
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
				{ path: "src/a.ts", oldPath: undefined, newLine: 4, oldLine: 3, body: renderInlineBody(finding("src/a.ts", 4, "low")) },
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
		expect(review.comments.map((c) => c.body)).toEqual([renderInlineBody(finding("src/a.ts", 3, "nit", "kept"))]);
		expect(review.unanchored).toHaveLength(5);
		expect(review.dropped).toEqual([]);
	});

	test("findings sort by code point, not locale", () => {
		const findings = [finding("a_b.ts", 1, "low"), finding("a-b.ts", 1, "low")];
		const review = compileReview(FILES, { ...NO_SWOT, findings }, NO_OPTS);
		expect(review.unanchored.map((f) => f.path)).toEqual(["a-b.ts", "a_b.ts"]);
	});
});

describe("review rounds, slice A", () => {
	const swallowed = (path: string, line: number, others: string[] = []): Finding => ({
		...finding(path, line, "high", "swallows the error"),
		class: "swallowed error",
		otherPlaces: others,
	});
	const improvement = (line: number, tag = "new API"): Finding => ({
		...finding("src/a.ts", line, "nit", "use structuredClone"),
		kind: "improvement",
		tag,
	});
	const WITH_IMPROVEMENTS = { ...NO_OPTS, improvements: true };

	describe("parseAgentOutput", () => {
		test("reads class, otherPlaces, preExisting, tag and kind", () => {
			const text = JSON.stringify({
				findings: [
					{ path: "a", line: 1, tier: "high", body: "x", class: " swallowed error ", otherPlaces: ["b:2", "c:3"], preExisting: true, tag: "security" },
					{ path: "a", line: 2, kind: "improvement", body: "y", tag: "cleanup" },
					{ path: "a", line: 3, tier: "low", body: "z" },
				],
			});
			const [first, second, third] = parseAgentOutput(text).findings;
			expect(first).toMatchObject({ class: "swallowed error", otherPlaces: ["b:2", "c:3"], preExisting: true, tag: "security" });
			expect(second).toMatchObject({ kind: "improvement", tag: "cleanup", tier: "nit" });
			expect(third.class).toBeUndefined();
			expect(third.preExisting).toBeUndefined();
			expect(third.kind).toBeUndefined();
		});
	});

	describe("renderComment", () => {
		test("adds the same-class line after the body", () => {
			expect(renderComment(swallowed("src/a.ts", 2, ["src/b.ts:8", "src/c.ts:9"]))).toBe(
				`${TIER_EMOJI.high} **High** swallows the error\n\nSame class (swallowed error) at: src/b.ts:8, src/c.ts:9`,
			);
		});

		test("shows the tag after the tier", () => {
			expect(renderComment({ ...finding("a", 1, "medium", "token in log"), tag: "security" })).toBe(
				`${TIER_EMOJI.medium} **Medium** \`security\` token in log`,
			);
		});

		test("marks a pre-existing finding and says it does not block", () => {
			expect(renderComment({ ...finding("a", 1, "medium", "empty TIMEOUT"), preExisting: true })).toBe(
				`${TIER_EMOJI.medium} **Medium** \`Pre-existing\` empty TIMEOUT This PR did not add it, and it does not block.`,
			);
		});

		test("renders an improvement as optional", () => {
			expect(renderComment(improvement(2))).toBe(
				"💡 **Improvement** `new API` use structuredClone\n\nOptional. This does not count toward the verdict, and you do not need to reply.",
			);
		});
	});

	describe("bug class", () => {
		test("posts one comment for the class and lists the places in the Warning callout", () => {
			const review = compileReview(
				FILES,
				{ ...NO_SWOT, findings: [swallowed("src/a.ts", 2, ["src/new.ts:1", "src/new.ts:2"])] },
				NO_OPTS,
			);
			expect(review.comments).toHaveLength(1);
			expect(review.comments[0].body).toContain("Same class (swallowed error) at: src/new.ts:1, src/new.ts:2");
			expect(review.body).toContain(
				"> [!WARNING]\n> **Opportunities**\n>\n> - Swallowed error in 3 places: `src/a.ts:2`, `src/new.ts:1`, `src/new.ts:2`\n",
			);
		});

		test("writes the class names into a hidden marker, once per class", () => {
			const review = compileReview(
				FILES,
				{ ...NO_SWOT, findings: [swallowed("src/a.ts", 2, ["src/new.ts:1"]), swallowed("src/a.ts", 3), finding("src/new.ts", 2, "low")] },
				NO_OPTS,
			);
			expect(review.body).toContain('<!-- dg:thrash-classes ["swallowed error"] -->');
		});

		test("writes no class marker when no finding has a class", () => {
			const review = compileReview(FILES, { ...NO_SWOT, findings: [finding("src/a.ts", 2, "low")] }, NO_OPTS);
			expect(review.body).not.toContain("dg:thrash-classes");
		});
	});

	describe("pre-existing", () => {
		test("never counts toward the tally or the verdict, and is listed in the summary", () => {
			const review = compileReview(
				FILES,
				{ ...NO_SWOT, findings: [{ ...finding("src/a.ts", 2, "critical"), preExisting: true }] },
				NO_OPTS,
			);
			expect(review.tally.critical).toBe(0);
			expect(review.verdict).toBe("approve");
			expect(review.comments).toHaveLength(1);
			expect(review.body).toContain("- **Pre-existing:** 1, not counted.\n  - 💀 `src/a.ts:2` critical title");
		});

		test("an earlier pre-existing thread is not an open finding", () => {
			const earlier = thread("src/a.ts", 2, `${TIER_EMOJI.high} **High** \`Pre-existing\` old`);
			expect(openPriorTally([earlier])).toEqual(emptyTally());
		});
	});

	describe("improvements", () => {
		test("are dropped and not shown when the option is off", () => {
			const review = compileReview(FILES, { ...NO_SWOT, findings: [improvement(2)] }, NO_OPTS);
			expect(review.comments).toHaveLength(0);
			expect(review.body).not.toContain("💡");
		});

		test("post as optional comments, show 💡 after 🔬, and never count", () => {
			const review = compileReview(FILES, { ...NO_SWOT, findings: [improvement(2)] }, WITH_IMPROVEMENTS);
			expect(review.comments).toHaveLength(1);
			expect(review.comments[0].body).toStartWith("💡 **Improvement** `new API`");
			expect(review.tally).toEqual(emptyTally());
			expect(review.verdict).toBe("approve");
			expect(review.body).toContain('<span title="Nit">🔬</span> 0 · <span title="Improvement">💡</span> 1 · ');
		});

		test("show 💡 0 when enabled and none were found", () => {
			const review = compileReview(FILES, { ...NO_SWOT, findings: [] }, WITH_IMPROVEMENTS);
			expect(review.body).toContain("💡</span> 0");
		});

		test("stop at three by default and at maxImprovements when set", () => {
			const five = [improvement(1), improvement(2), improvement(3), improvement(4), improvement(5)];
			const byDefault = compileReview(FILES, { ...NO_SWOT, findings: five }, WITH_IMPROVEMENTS);
			expect(byDefault.comments).toHaveLength(3);
			const capped = compileReview(FILES, { ...NO_SWOT, findings: five }, { ...WITH_IMPROVEMENTS, maxImprovements: 1 });
			expect(capped.comments).toHaveLength(1);
			expect(capped.dropped.map((d) => d.reason)).toEqual(Array(4).fill("max-improvements"));
		});

		test("do not use the comment cap or the nit ladder", () => {
			const review = compileReview(
				FILES,
				{ ...NO_SWOT, findings: [finding("src/a.ts", 2, "high"), improvement(3)] },
				{ ...WITH_IMPROVEMENTS, maxComments: 1, minTier: "high" },
			);
			expect(review.comments).toHaveLength(2);
		});

		test("an earlier improvement thread is not an open finding and is not reposted", () => {
			const earlier = thread("src/a.ts", 2, "💡 **Improvement** `new API` old");
			expect(openPriorTally([earlier])).toEqual(emptyTally());
			const review = compileReview(
				FILES,
				{ ...NO_SWOT, findings: [improvement(2)] },
				{ ...WITH_IMPROVEMENTS, existing: [earlier] },
			);
			expect(review.comments).toHaveLength(0);
		});

		test("stay out of the local address file", () => {
			const review = compileReview(
				FILES,
				{ ...NO_SWOT, findings: [finding("src/a.ts", 2, "high"), improvement(3)] },
				WITH_IMPROVEMENTS,
			);
			expect(review.comments).toHaveLength(2);
			expect(renderAddressFile(review)).not.toContain("Improvement");
			expect(renderAddressFile(review)).toContain("src/a.ts:2");
		});

		test("the policy turns them on and sets the cap", () => {
			const policy = parsePolicy("improvements: true\nmaxImprovements: 1\nphases:\n  - block: { critical: 0 }\n");
			const review = compileReview(
				FILES,
				{ ...NO_SWOT, findings: [improvement(1), improvement(2)] },
				{ ...NO_OPTS, policy, round: 1 },
			);
			expect(review.comments).toHaveLength(1);
		});
	});

	describe("round note", () => {
		const BLOCKING = { ...NO_SWOT, findings: [finding("src/a.ts", 2, "high")] };
		const policy = (extra = "") => parsePolicy(`${extra}phases:\n  - block: { critical: 0, high: 0 }\n`);

		test("adds an Important callout after the default three rounds while a blocker is open", () => {
			const review = compileReview(FILES, BLOCKING, { ...NO_OPTS, policy: policy(), round: 4 });
			expect(review.verdict).toBe("request_changes");
			expect(review.body).toContain(
				"> [!IMPORTANT]\n> **Round 4, and a blocker is still open.**\n>\n> - Try a new approach, or ask a person to review.\n",
			);
		});

		test("waits for round to pass reconsiderAfter", () => {
			expect(compileReview(FILES, BLOCKING, { ...NO_OPTS, policy: policy(), round: 3 }).body).not.toContain("[!IMPORTANT]");
			const custom = policy("reconsiderAfter: 1\n");
			expect(compileReview(FILES, BLOCKING, { ...NO_OPTS, policy: custom, round: 2 }).body).toContain("Round 2, and a blocker");
		});

		test("is absent when nothing blocks, and never changes the verdict", () => {
			const clean = compileReview(FILES, { ...NO_SWOT, findings: [] }, { ...NO_OPTS, policy: policy(), round: 9 });
			expect(clean.body).not.toContain("[!IMPORTANT]");
			const capped = compileReview(FILES, BLOCKING, { ...NO_OPTS, policy: policy(), round: 5, maxEvent: "comment" });
			expect(capped.verdict).toBe("comment");
			expect(capped.body).toContain("[!IMPORTANT]");
		});
	});

	describe("summary order", () => {
		test("tally line, Important, Note, Tip, Warning, then the plain bullets", () => {
			const review = compileReview(
				FILES,
				{
					changed: "Adds a.",
					strengths: ["Tested."],
					opportunities: ["Split it."],
					findings: [finding("src/a.ts", 2, "high"), { ...finding("src/a.ts", 3, "low"), preExisting: true }],
				},
				{
					...NO_OPTS,
					policy: parsePolicy("phases:\n  - block: { high: 0 }\n"),
					round: 4,
					reReview: { sha: "4b7a9d0aaaa", files: 3, lines: 42 },
					cleared: { fixed: 2, sha: "9f3c2e1bbbb", answered: 1 },
				},
			);
			const at = (text: string) => {
				const index = review.body.indexOf(text);
				expect(index).toBeGreaterThan(-1);
				return index;
			};
			const order = [
				at("## Thrash review"),
				at("**Round:** 4"),
				at("[!IMPORTANT]"),
				at("[!NOTE]"),
				at("[!TIP]"),
				at("[!WARNING]"),
				at("- **Cleared:**"),
				at("- **Pre-existing:**"),
				at("**Trigger:**"),
			];
			expect(order).toEqual([...order].sort((a, b) => a - b));
			expect(review.body).toContain("> **Re-review**\n>\n> - Only the diff since `4b7a9d0`: 3 files, 42 lines.\n");
			expect(review.body).toContain("- **Cleared:** 2 fixed in `9f3c2e1`, 1 answered.");
		});

		test("leaves the Re-review and Cleared slots out when no data is given", () => {
			const review = compileReview(FILES, { ...NO_SWOT, changed: "Adds a.", findings: [] }, NO_OPTS);
			expect(review.body).not.toContain("Re-review");
			expect(review.body).not.toContain("Cleared");
			expect(review.body).not.toContain("Pre-existing");
		});

		test("Cleared names only the parts that are non-zero", () => {
			const only = (cleared: { fixed: number; sha?: string; answered: number }) =>
				compileReview(FILES, { ...NO_SWOT, findings: [] }, { ...NO_OPTS, cleared }).body;
			expect(only({ fixed: 0, answered: 2 })).toContain("- **Cleared:** 2 answered.");
			expect(only({ fixed: 1, sha: "abcdef0123", answered: 0 })).toContain("- **Cleared:** 1 fixed in `abcdef0`.");
			expect(only({ fixed: 0, answered: 0 })).not.toContain("Cleared");
		});
	});
});

describe("clearing and history", () => {
	const POLICY = parsePolicy("phases:\n  - block: { high: 0 }\n");
	const awaitFinding: Finding = {
		...finding("src/a.ts", 2, "high"),
		title: "Missing await",
		body: "The call is not awaited.",
	};
	const outdated = (body: string, resolved = false): ReviewThread => ({
		...thread("src/a.ts", 2, body, resolved),
		line: null,
		originalLine: 2,
		outdated: true,
	});
	const run = (existing: ReviewThread[], findings: Finding[], extra = {}) =>
		compileReview(FILES, { ...NO_SWOT, findings }, { ...NO_OPTS, existing, policy: POLICY, headSha: "abcdef1234567", ...extra });

	test("clears an outdated thread when the re-review finds nothing like it", () => {
		const review = run([outdated(renderInlineBody(awaitFinding))], []);
		expect(review.tally.high).toBe(0);
		expect(review.verdict).toBe("approve");
		expect(review.body).toContain("- **Cleared:** 1 fixed in `abcdef1`.");
	});

	test("keeps an outdated thread open when its finding comes back at a new line", () => {
		const review = run([outdated(renderInlineBody(awaitFinding))], [{ ...awaitFinding, line: 3 }]);
		expect(review.tally.high).toBe(1);
		expect(review.verdict).toBe("request_changes");
		expect(review.reason).toBe("1 high finding is open");
		expect(review.body).not.toContain("Cleared");
	});

	test("matches on the class key when the finding has a class", () => {
		const earlier = { ...awaitFinding, class: "Missing await" };
		const again = { ...awaitFinding, title: "Other words", class: "missing-await", line: 3 };
		expect(run([outdated(renderInlineBody(earlier))], [again]).tally.high).toBe(1);
	});

	test("a different finding in the same file does not hold the thread open", () => {
		const other = { ...awaitFinding, title: "Unused import", tier: "medium" as Tier, line: 3 };
		const review = run([outdated(renderInlineBody(awaitFinding))], [other]);
		expect(review.tally.high).toBe(0);
		expect(review.tally.medium).toBe(1);
		expect(review.body).toContain("1 fixed");
	});

	test("a thread without a marker is never cleared and never absorbs a finding", () => {
		const legacy = outdated(`${TIER_EMOJI.high} **High** old`);
		const review = run([legacy], [{ ...awaitFinding, line: 3, tier: "low" }]);
		expect(review.tally.high).toBe(1);
		expect(review.tally.low).toBe(1);
		expect(run([legacy], []).body).not.toContain("Cleared");
	});

	test("a thread that is still anchored is not cleared", () => {
		const open = thread("src/a.ts", 2, renderInlineBody(awaitFinding));
		const review = run([open], []);
		expect(review.tally.high).toBe(1);
		expect(review.body).not.toContain("Cleared");
	});

	test("counts threads cleared by a reply as answered", () => {
		const answered: ReviewThread = {
			...thread("src/a.ts", 3, renderInlineBody(awaitFinding)),
			comments: [
				{ id: "1", author: "bot", body: renderInlineBody(awaitFinding), createdAt: "", diffHunk: "" },
				{ id: "2", author: "dev", body: "done", createdAt: "", diffHunk: "" },
			],
		};
		const review = run([answered], []);
		expect(review.tally.high).toBe(0);
		expect(review.body).toContain("- **Cleared:** 1 answered.");
	});

	test("clears without a policy too, and names the fixed count only", () => {
		const review = compileReview(FILES, { ...NO_SWOT, findings: [] }, { ...NO_OPTS, existing: [outdated(renderInlineBody(awaitFinding))] });
		expect(review.body).toContain("- **Cleared:** 1 fixed.");
	});

	test("counts only open findings in the verdict sentence", () => {
		const two = [awaitFinding, { ...awaitFinding, title: "Second", line: 3 }];
		expect(run([], two).reason).toBe("2 high findings are open");
	});

	const classed: Finding = { ...awaitFinding, class: "Missing await" };
	const hint = "This class came up in 3 recent PRs. Consider a rule in docs/code_review.md or a lint check.";

	test("adds the repeated-class hint at 3 recent PRs and not at 2", () => {
		expect(run([], [classed], { classHistory: { "missing await": 3 } }).body).toContain(hint);
		expect(run([], [classed], { classHistory: { "missing await": 2 } }).body).not.toContain("recent PRs");
		expect(run([], [awaitFinding], { classHistory: { "missing await": 5 } }).body).not.toContain("recent PRs");
	});

	test("an inline comment carries a hidden finding key", () => {
		expect(renderInlineBody(classed)).toContain('<!-- dg:thrash-finding "missing await" -->');
		expect(renderInlineBody({ ...awaitFinding, title: "" })).not.toContain("dg:thrash-finding");
	});

	describe("review history", () => {
		const review = (body: string, commitId: string, author = "thrashley[bot]", state = "COMMENTED"): ReviewSummary => ({
			author,
			body: `${body}\n${THRASH_REVIEW_MARKER}`,
			state,
			commitId,
		});

		test("lastReviewedSha takes the latest submitted thrash review", () => {
			const reviews = [
				review("one", "aaa1111"),
				{ author: "dev", body: "lgtm", state: "APPROVED", commitId: "ccc3333" },
				review("two", "bbb2222"),
				review("draft", "ddd4444", "thrashley[bot]", "PENDING"),
			];
			expect(lastReviewedSha(reviews)).toBe("bbb2222");
			expect(lastReviewedSha(reviews, "thrashley")).toBe("bbb2222");
			expect(lastReviewedSha(reviews, "someone-else")).toBeUndefined();
			expect(lastReviewedSha([])).toBeUndefined();
		});

		test("parseClassMarker reads the class names back", () => {
			expect(parseClassMarker(`text\n${THRASH_CLASSES_MARKER_PREFIX}["a b","c"] -->\n`)).toEqual(["a b", "c"]);
			expect(parseClassMarker("no marker")).toEqual([]);
			expect(parseClassMarker(`${THRASH_CLASSES_MARKER_PREFIX}not json -->`)).toEqual([]);
		});

		test("classPrCounts counts each class once per PR", () => {
			const marker = (names: string[]) => `${THRASH_CLASSES_MARKER_PREFIX}${JSON.stringify(names)} -->`;
			const counts = classPrCounts(
				[
					[review(marker(["x", "y"]), "a"), review(marker(["x"]), "b")],
					[review(marker(["x"]), "c")],
					[{ author: "dev", body: marker(["y"]), state: "COMMENTED", commitId: "d" }],
				],
			);
			expect(counts).toEqual({ x: 2, y: 1 });
		});
	});
});

describe("incremental review safety", () => {
	const POLICY = parsePolicy("phases:\n  - block: { high: 0 }\n");
	const SINCE = { sha: "aaa1111222", files: 1, lines: 2 };
	const DELTA = FILES.filter((f) => f.path === "src/a.ts");
	const awaitFinding: Finding = {
		...finding("src/a.ts", 2, "high"),
		title: "Missing await",
		body: "The call is not awaited.",
	};
	const grouped: Finding = { ...awaitFinding, class: "Missing await", otherPlaces: ["src/new.ts:1"] };
	const outdated = (source: Finding): ReviewThread => ({
		...thread("src/a.ts", 2, renderInlineBody(source)),
		line: null,
		originalLine: 2,
		outdated: true,
	});
	const compile = (files: typeof FILES, findings: Finding[], extra = {}) =>
		compileReview(files, { ...NO_SWOT, findings }, { ...NO_OPTS, headSha: "abcdef1234567", ...extra });

	describe("clearing a grouped class", () => {
		test("records every place of a grouped class in the hidden finding marker", () => {
			expect(renderInlineBody(grouped)).toContain(
				'<!-- dg:thrash-finding {"key":"missing await","places":["src/a.ts:2","src/new.ts:1"]} -->',
			);
		});

		test("keeps the thread open when a recorded place was not re-reviewed", () => {
			const review = compile(DELTA, [], { existing: [outdated(grouped)], policy: POLICY, reReview: SINCE });
			expect(review.tally.high).toBe(1);
			expect(review.verdict).toBe("request_changes");
			expect(review.body).not.toContain("Cleared");
		});

		test("clears the thread when every recorded place was re-reviewed and the class did not return", () => {
			const review = compile(FILES, [], { existing: [outdated(grouped)], policy: POLICY, reReview: SINCE });
			expect(review.tally.high).toBe(0);
			expect(review.body).toContain("- **Cleared:** 1 fixed in `abcdef1`.");
		});

		test("keeps the thread open when the class returns at another recorded place", () => {
			const returned: Finding = { ...finding("src/new.ts", 1, "high"), title: "Missing await", class: "Missing await" };
			const review = compile(FILES, [returned], { existing: [outdated(grouped)], policy: POLICY });
			expect(review.tally.high).toBe(1);
			expect(review.body).not.toContain("Cleared");
		});

		describe("a class found again at a recorded place", () => {
			const returned: Finding = { ...finding("src/new.ts", 1, "high"), title: "Missing await", class: "Missing await" };
			const current = thread("src/a.ts", 2, renderInlineBody(grouped));

			test("is not counted or posted again while the primary thread is current", () => {
				const review = compile(FILES, [returned], { existing: [current], policy: POLICY });
				expect(review.tally.high).toBe(1);
				expect(review.comments).toHaveLength(0);
				expect(review.dropped.map((d) => d.reason)).toEqual(["duplicate"]);
				expect(review.body).not.toContain("dg:thrash-unposted");
			});

			test("is not posted again when the primary thread is outdated", () => {
				const review = compile(FILES, [returned], { existing: [outdated(grouped)], policy: POLICY });
				expect(review.tally.high).toBe(1);
				expect(review.comments).toHaveLength(0);
				expect(review.dropped.map((d) => d.reason)).toEqual(["duplicate"]);
			});

			test("does not absorb an ungrouped finding that shares its title in the same file", () => {
				const ungrouped = thread("src/a.ts", 2, renderInlineBody(awaitFinding));
				const review = compile(FILES, [{ ...awaitFinding, line: 3 }], { existing: [ungrouped], policy: POLICY });
				expect(review.tally.high).toBe(2);
				expect(review.comments).toHaveLength(1);
			});
		});

		test("clears an ungrouped thread even when its file is not in the delta", () => {
			const review = compile(FILES.filter((f) => f.path === "src/new.ts"), [], {
				existing: [outdated(awaitFinding)],
				policy: POLICY,
				reReview: SINCE,
			});
			expect(review.tally.high).toBe(0);
		});
	});

	describe("cleared threads", () => {
		const gone = outdated(grouped);
		const UNRELATED = FILES.filter((f) => f.path === "new/name.ts");
		const unrelated = (extra = {}) =>
			compile(UNRELATED, [], { existing: [gone], policy: POLICY, reReview: SINCE, ...extra });

		test("writes the id of a cleared thread into a hidden marker", () => {
			const review = compile(FILES, [], { existing: [gone], policy: POLICY, reReview: SINCE });
			expect(review.body).toContain(`${THRASH_CLEARED_MARKER_PREFIX}["${gone.threadId}"] -->`);
		});

		test("leaves the marker out when nothing was ever cleared", () => {
			expect(compile(FILES, [], { policy: POLICY }).body).not.toContain("dg:thrash-cleared");
		});

		test("keeps a cleared grouped class cleared on a later delta that omits its files", () => {
			const review = unrelated({ clearedThreads: [gone.threadId] });
			expect(review.tally.high).toBe(0);
			expect(review.verdict).toBe("approve");
			expect(review.body).not.toContain("Cleared");
		});

		test("without the marker the same delta reopens the class", () => {
			expect(unrelated().tally.high).toBe(1);
		});

		test("carries earlier cleared ids forward and adds the ones cleared this round", () => {
			const review = compile(FILES, [], { existing: [gone], policy: POLICY, clearedThreads: ["earlier"] });
			expect(review.body).toContain(`${THRASH_CLEARED_MARKER_PREFIX}["earlier","${gone.threadId}"] -->`);
		});

		test("keeps carrying an id after its delta cleared nothing new", () => {
			expect(unrelated({ clearedThreads: [gone.threadId] }).body).toContain(
				`${THRASH_CLEARED_MARKER_PREFIX}["${gone.threadId}"] -->`,
			);
		});

		test("counts and posts the class again when it returns after it was cleared", () => {
			const returned = { ...grouped, otherPlaces: undefined };
			const review = compile(FILES, [returned], { existing: [gone], policy: POLICY, clearedThreads: [gone.threadId] });
			expect(review.tally.high).toBe(1);
			expect(review.comments).toHaveLength(1);
		});

		test("parseClearedMarker reads the ids back", () => {
			expect(parseClearedMarker(`text\n${THRASH_CLEARED_MARKER_PREFIX}["a","b"] -->\n`)).toEqual(["a", "b"]);
			expect(parseClearedMarker("no marker")).toEqual([]);
			expect(parseClearedMarker(`${THRASH_CLEARED_MARKER_PREFIX}not json -->`)).toEqual([]);
		});

		test("clearedThreadIds reads only the latest thrash review", () => {
			const review = (ids: string[], commitId: string, author = "thrashley[bot]"): ReviewSummary => ({
				author,
				body: `${THRASH_CLEARED_MARKER_PREFIX}${JSON.stringify(ids)} -->\n${THRASH_REVIEW_MARKER}`,
				state: "COMMENTED",
				commitId,
			});
			const reviews = [review(["old"], "aaa1111"), review(["new"], "bbb2222"), review(["other"], "ccc3333", "dev")];
			expect(clearedThreadIds(reviews, "thrashley[bot]")).toEqual(["new"]);
			expect(clearedThreadIds([], "thrashley[bot]")).toEqual([]);
		});
	});

	describe("phase order", () => {
		const PHASED = parsePolicy(
			"phases:\n  - name: strict\n    through: 1\n    block: { high: 0 }\n  - name: relaxed\n    requiresClear: [high]\n    nits: false\n    block: { high: 1 }\n",
		);

		test("enters the next phase once the fixed findings are cleared", () => {
			const nit = finding("src/a.ts", 3, "nit");
			const review = compile(FILES, [nit], { existing: [outdated(awaitFinding)], policy: PHASED, round: 2 });
			expect(review.phase).toBe("relaxed");
			expect(review.dropped.map((d) => d.reason)).toContain("below-min-tier");
		});

		test("stays in the earlier phase while a prior finding is still open", () => {
			const stillOpen = thread("src/a.ts", 2, renderInlineBody(awaitFinding));
			const review = compile(FILES, [], { existing: [stillOpen], policy: PHASED, round: 2 });
			expect(review.phase).toBe("strict");
		});
	});

	describe("delta tally without a policy", () => {
		const untouched = thread(
			"src/new.ts",
			1,
			renderInlineBody({ ...finding("src/new.ts", 1, "critical"), title: "Hardcoded secret" }),
		);

		test("counts an open blocker in a file the delta did not touch", () => {
			const review = compile(DELTA, [], { existing: [untouched], reReview: SINCE });
			expect(review.tally.critical).toBe(1);
			expect(review.verdict).toBe("request_changes");
		});

		test("a full review without a policy still tallies only its own findings", () => {
			const review = compile(FILES, [], { existing: [untouched] });
			expect(review.tally.critical).toBe(0);
			expect(review.verdict).toBe("approve");
		});
	});

	describe("unposted blockers", () => {
		const classed: Finding = { ...awaitFinding, class: "Missing await" };

		test("lists the keys of blocking findings that were not posted in a hidden marker", () => {
			const review = compile(FILES, [classed, finding("src/a.ts", 3, "low")], { policy: POLICY, maxComments: 0 });
			expect(review.body).toContain('<!-- dg:thrash-unposted ["missing await"] -->');
		});

		test("lists a blocking finding that names no file in the diff", () => {
			const lost = { ...finding("nowhere.ts", 1, "high"), title: "Lost" };
			expect(compile(FILES, [lost], { policy: POLICY }).body).toContain('<!-- dg:thrash-unposted ["lost"] -->');
		});

		test("leaves the marker out when every blocker posted", () => {
			expect(compile(FILES, [classed], { policy: POLICY }).body).not.toContain("dg:thrash-unposted");
		});

		test("leaves a tier without a limit out of the marker", () => {
			const medium = finding("src/a.ts", 3, "medium");
			expect(compile(FILES, [medium], { policy: POLICY, maxComments: 0 }).body).not.toContain("dg:thrash-unposted");
		});

		describe("a blocker dropped as a duplicate", () => {
			const lowThread = thread("src/a.ts", 2, renderInlineBody({ ...awaitFinding, tier: "low" }));
			const answered: ReviewThread = {
				...thread("src/a.ts", 2, renderInlineBody(awaitFinding)),
				comments: [
					{ id: "1", author: "bot", body: renderInlineBody(awaitFinding), createdAt: "", diffHunk: "" },
					{ id: "2", author: "dev", body: "on it", createdAt: "", diffHunk: "" },
				],
			};

			test.each([
				["a lower-tier thread", lowThread],
				["a pre-existing thread", thread("src/a.ts", 2, renderInlineBody({ ...awaitFinding, preExisting: true }))],
				["an answered thread", answered],
			])("is listed when %s sits on its line", (_name, existing) => {
				const review = compile(FILES, [awaitFinding], { existing: [existing], policy: POLICY });
				expect(review.dropped.map((d) => d.reason)).toEqual(["duplicate"]);
				expect(review.tally.high).toBe(1);
				expect(review.body).toContain('<!-- dg:thrash-unposted ["missing await"] -->');
			});

			test.each([
				["an equal tier", "high"],
				["a higher tier", "critical"],
			] as const)("is left out when an open thread of %s holds it", (_name, tier) => {
				const holder = thread("src/a.ts", 2, renderInlineBody({ ...awaitFinding, tier }));
				const review = compile(FILES, [awaitFinding], { existing: [holder], policy: POLICY });
				expect(review.dropped.map((d) => d.reason)).toEqual(["duplicate"]);
				expect(review.body).not.toContain("dg:thrash-unposted");
			});

			test("is left out when its tier has no limit", () => {
				const medium = { ...awaitFinding, tier: "medium" as Tier };
				const holder = thread("src/a.ts", 2, renderInlineBody({ ...awaitFinding, tier: "low" }));
				const review = compile(FILES, [medium], { existing: [holder], policy: POLICY });
				expect(review.body).not.toContain("dg:thrash-unposted");
			});

			test("is left out when it is pre-existing", () => {
				const review = compile(FILES, [{ ...awaitFinding, preExisting: true }], { existing: [lowThread], policy: POLICY });
				expect(review.body).not.toContain("dg:thrash-unposted");
			});
		});

		describe("a class that gains a place its thread never recorded", () => {
			const widened: Finding = {
				...awaitFinding,
				class: "Missing await",
				otherPlaces: ["src/new.ts:1", "new/name.ts:1"],
			};
			const unposted = '<!-- dg:thrash-unposted ["missing await"] -->';

			test("is listed while a current thread holds it", () => {
				const holder = thread("src/a.ts", 2, renderInlineBody(grouped));
				const review = compile(FILES, [widened], { existing: [holder], policy: POLICY });
				expect(review.dropped.map((d) => d.reason)).toEqual(["duplicate"]);
				expect(review.tally.high).toBe(1);
				expect(review.body).toContain(unposted);
			});

			test("is listed while an outdated grouped thread holds it", () => {
				const returned: Finding = { ...widened, path: "src/new.ts", line: 1, otherPlaces: ["new/name.ts:1"] };
				const review = compile(FILES, [returned], { existing: [outdated(grouped)], policy: POLICY });
				expect(review.dropped.map((d) => d.reason)).toEqual(["duplicate"]);
				expect(review.body).toContain(unposted);
			});

			test("is listed while a thread with one place holds it", () => {
				const holder = thread("src/a.ts", 2, renderInlineBody(awaitFinding));
				const review = compile(FILES, [widened], { existing: [holder], policy: POLICY });
				expect(review.body).toContain(unposted);
			});

			test("is left out once its thread records every place", () => {
				const holder = thread("src/a.ts", 2, renderInlineBody(widened));
				const review = compile(FILES, [widened], { existing: [holder], policy: POLICY });
				expect(review.dropped.map((d) => d.reason)).toEqual(["duplicate"]);
				expect(review.body).not.toContain("dg:thrash-unposted");
			});

			test("posts its own thread once the recorded places are fixed and only the new place remains", () => {
				const remaining: Finding = { ...finding("new/name.ts", 1, "high"), title: "Missing await", class: "Missing await" };
				const review = compile(FILES, [remaining], { existing: [outdated(grouped)], policy: POLICY });
				expect(review.comments).toHaveLength(1);
				expect(review.tally.high).toBe(1);
				expect(review.body).toContain("- **Cleared:** 1 fixed");
				expect(review.body).not.toContain("dg:thrash-unposted");
			});
		});

		test("parseUnpostedMarker reads the keys back", () => {
			expect(parseUnpostedMarker(`text\n${THRASH_UNPOSTED_MARKER_PREFIX}["a b","c"] -->\n`)).toEqual(["a b", "c"]);
			expect(parseUnpostedMarker("no marker")).toEqual([]);
			expect(parseUnpostedMarker(`${THRASH_UNPOSTED_MARKER_PREFIX}not json -->`)).toEqual([]);
		});
	});

	describe("publication anchors", () => {
		const PR_DIFF = parseUnifiedDiff(`diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 3;
 export { a, b };
`);
		const DELTA_DIFF = parseUnifiedDiff(`diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,6 +1,5 @@
 const a = 1;
 const b = 3;
-const c = 4;
 export { a, b };
 const t1 = 1;
 const t2 = 2;
diff --git a/src/reverted.ts b/src/reverted.ts
--- a/src/reverted.ts
+++ b/src/reverted.ts
@@ -1,2 +1,1 @@
 const r = 1;
-const s = 2;
`);
		const anchored = (findings: Finding[]) =>
			compile(DELTA_DIFF, findings, { reReview: SINCE, prFiles: PR_DIFF }).comments;

		test("keeps a new-side line that the full PR diff also shows", () => {
			const [comment] = anchored([finding("src/a.ts", 2, "high")]);
			expect(comment).toMatchObject({ path: "src/a.ts", newLine: 2 });
		});

		test("posts a file comment for a delta line the full PR diff does not show", () => {
			const [comment] = anchored([finding("src/a.ts", 4, "high")]);
			expect(comment.path).toBe("src/a.ts");
			expect(comment.newLine).toBeUndefined();
			expect(comment.oldLine).toBeUndefined();
		});

		test("posts a file comment for an old-side line, whose number is not a PR base line", () => {
			const [comment] = anchored([finding("src/a.ts", 3, "high", "gone", "old")]);
			expect(comment.path).toBe("src/a.ts");
			expect(comment.oldLine).toBeUndefined();
			expect(comment.newLine).toBeUndefined();
		});

		test("does not post a finding on a file the full PR diff does not contain", () => {
			const review = compile(DELTA_DIFF, [finding("src/reverted.ts", 1, "high")], { reReview: SINCE, prFiles: PR_DIFF });
			expect(review.comments).toHaveLength(0);
			expect(review.unanchored).toHaveLength(1);
			expect(review.tally.high).toBe(1);
		});

		test("matches an existing thread by its PR line", () => {
			const existing = [thread("src/a.ts", 2, renderInlineBody(finding("src/a.ts", 2, "high")))];
			const review = compile(DELTA_DIFF, [finding("src/a.ts", 2, "high")], {
				existing,
				reReview: SINCE,
				prFiles: PR_DIFF,
			});
			expect(review.dropped.map((d) => d.reason)).toEqual(["duplicate"]);
			expect(review.tally.high).toBe(1);
		});
	});

	describe("class coalescing", () => {
		const at = (path: string, line: number, tier: Tier, name: string, extra: Partial<Finding> = {}): Finding => ({
			...finding(path, line, tier),
			title: "Missing await",
			class: name,
			...extra,
		});

		test("merges same-class findings from different chunks into one finding at the highest tier", () => {
			const review = compile(
				FILES,
				[at("src/a.ts", 2, "medium", "Missing await"), at("src/new.ts", 1, "high", "missing-await")],
			);
			expect(review.comments).toHaveLength(1);
			expect(review.comments[0]).toMatchObject({ path: "src/a.ts", tier: "high" });
			expect(review.comments[0].body).toContain("Same class (Missing await) at: src/new.ts:1");
			expect(review.tally).toMatchObject({ high: 1, medium: 0 });
			expect(review.body).toContain("Missing await in 2 places: `src/a.ts:2`, `src/new.ts:1`");
		});

		test("merges every location once and keeps the places a finding already listed", () => {
			const review = compile(FILES, [
				at("src/a.ts", 2, "high", "Missing await", { otherPlaces: ["src/new.ts:1"] }),
				at("src/new.ts", 1, "high", "Missing await", { otherPlaces: ["src/a.ts:2", "src/name.ts:9"] }),
			]);
			expect(review.comments).toHaveLength(1);
			expect(review.comments[0].body).toContain("Same class (Missing await) at: src/new.ts:1, src/name.ts:9");
			expect(review.tally.high).toBe(1);
		});

		test("keeps a pre-existing finding apart from a blocking one of the same class", () => {
			const review = compile(FILES, [
				at("src/a.ts", 2, "high", "Missing await", { preExisting: true }),
				at("src/new.ts", 1, "medium", "Missing await"),
			]);
			expect(review.comments).toHaveLength(2);
			expect(review.preExisting).toHaveLength(1);
			expect(review.tally).toMatchObject({ high: 0, medium: 1 });
		});

		test("merges pre-existing findings of one class together", () => {
			const review = compile(FILES, [
				at("src/a.ts", 2, "low", "Missing await", { preExisting: true }),
				at("src/new.ts", 1, "medium", "Missing await", { preExisting: true }),
			]);
			expect(review.comments).toHaveLength(1);
			expect(review.preExisting).toHaveLength(1);
		});

		test("leaves findings without a class alone", () => {
			const review = compile(FILES, [finding("src/a.ts", 2, "high"), finding("src/new.ts", 1, "high")]);
			expect(review.comments).toHaveLength(2);
		});
	});
});
