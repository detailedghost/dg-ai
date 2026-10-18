import { describe, expect, test } from "bun:test";
import type { ReviewThread } from "../src/provider/types";
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
	test("prints old and new line numbers in fixed columns with the change marker", () => {
		const out = annotateDiff(FILES);
		expect(out).toContain("=== src/a.ts [modified]");
		expect(out).toContain("    1     1   const a = 1;");
		expect(out).toContain("          2 + const b = 3;");
		expect(out).toContain("    2       - const b = 2;");
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

describe("compileReview", () => {
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

	test("the findings table lists posted comments by tier with a titled icon", () => {
		const findings = [
			finding("src/a.ts", 3, "low"),
			{ ...finding("src/a.ts", 2, "critical"), title: "a | b" },
			finding("src/gone.ts", 1, "medium", "gone", "old"),
		];
		const review = compileReview(FILES, { ...NO_SWOT, findings }, { ...NO_OPTS, spice: 5 });
		expect(review.body).toContain(
			[
				"| | Where | Finding |",
				"|---|---|---|",
				'| <span title="Critical">💀</span> | `src/a.ts:2` | a \\| b |',
				'| <span title="Medium">⚠️</span> | `src/gone.ts:1` | medium title |',
				'| <span title="Low">🧹</span> | `src/a.ts:3` | low title |',
			].join("\n"),
		);
	});

	test("the nit ladder caps posted nits per spice level and folds the rest into the body", () => {
		const nits = Array.from({ length: 25 }, (_, i) => finding("src/a.ts", 1, "nit", `nit ${i}`));
		for (const spice of [1, 2, 3, 4, 5]) {
			const review = compileReview(FILES, { ...NO_SWOT, findings: nits }, { ...NO_OPTS, spice });
			const cap = Math.min(NIT_LADDER[spice], 25);
			expect(review.comments).toHaveLength(cap);
			expect(review.dropped.filter((d) => d.reason === "nit-ladder")).toHaveLength(25 - cap);
			expect(review.tally.nit).toBe(25);
			if (cap < 25) expect(review.body).toContain(`### Folded nits (${25 - cap})`);
		}
	});

	test("--min-tier overrides the ladder in both directions", () => {
		const findings = [finding("src/a.ts", 1, "nit"), finding("src/a.ts", 2, "low"), finding("src/a.ts", 3, "medium")];
		const onlyMedium = compileReview(FILES, { ...NO_SWOT, findings }, { ...NO_OPTS, spice: 5, minTier: "medium" });
		expect(onlyMedium.comments.map((c) => c.tier)).toEqual(["medium"]);
		expect(onlyMedium.dropped.map((d) => d.reason)).toEqual(["below-min-tier", "below-min-tier"]);

		const allNits = compileReview(FILES, { ...NO_SWOT, findings }, { ...NO_OPTS, spice: 1, minTier: "nit" });
		expect(allNits.comments.map((c) => c.tier)).toEqual(["nit", "low", "medium"]);
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

	test("unanchored findings stay in the body and still count toward the verdict", () => {
		const findings = [finding("", null, "critical", "cross-file race"), finding("src/a.ts", 99, "medium")];
		const review = compileReview(FILES, { ...NO_SWOT, findings }, NO_OPTS);
		expect(review.comments).toHaveLength(0);
		expect(review.unanchored).toHaveLength(2);
		expect(review.verdict).toBe("request_changes");
		expect(review.body).toContain("### Findings without a line anchor");
		expect(review.body).toContain("cross-file race");
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
	test("renders one /address section per anchored comment with the mapped severity", () => {
		const findings = [
			finding("src/a.ts", 2, "critical", "c"),
			finding("src/a.ts", 3, "nit", "n"),
			finding("src/a.ts", null, "high"),
		];
		const review = compileReview(FILES, { ...NO_SWOT, findings }, { ...NO_OPTS, spice: 5 });
		expect(renderAddressFile(review)).toBe(
			`## src/a.ts:2\n\nseverity: high\n\n${TIER_EMOJI.critical} **Critical** c\n\n## src/a.ts:3\n\nseverity: low\n\n${TIER_EMOJI.nit} **Nit** n\n`,
		);
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
		expect(() => stackFor(OPEN, 7)).toThrow(/#7/);
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
		expect(table).toContain("| PR | Link | 💀 | 🔥 | ⚠️ | 🧹 | 🔬 | Inline | Verdict |");
		expect(table).toContain(`| #12 | [review](${target}#r1) | 0 | 1 | 0 | 0 | 1 | 2 | Approve |`);
	});

	test("a degraded post names the refused verdict", () => {
		const posted = { url: `${target}#r1`, verdict: "comment" as const, degraded: true, commentCount: 2 };
		expect(renderTallyTable([{ target, review, posted }])).toContain("| Comment (approve refused) |");
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

describe("compileReview with merged chunks", () => {
	const chunk = (id: number) => ({ id, label: `source: m${id}`, files: [`m${id}/f.ts`], changed: 2000 });

	test("takes the verdict from the tally and lists every chunk", () => {
		const review = compileReview(
			FILES,
			{ ...NO_SWOT, findings: [{ ...finding("src/a.ts", 2, "critical") }] },
			{
				spice: 2,
				commentOnly: false,
				existing: [],
				coverage: { chunks: Array.from({ length: 9 }, (_, i) => chunk(i + 1)), skipped: [] },
			},
		);
		expect(review.verdict).toBe("request_changes");
		expect(review.body).toContain("### Review coverage");
		expect(review.body).not.toContain("Partial coverage");
		expect(review.body).toContain("9. `source: m9`");
	});

	test("approves a clean review whatever the chunk count", () => {
		const review = compileReview(
			FILES,
			{ ...NO_SWOT, findings: [] },
			{ spice: 2, commentOnly: false, existing: [], coverage: { chunks: [chunk(1), chunk(2)], skipped: [] } },
		);
		expect(review.verdict).toBe("approve");
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
