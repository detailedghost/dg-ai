import { describe, expect, test } from "bun:test";
import type { ReviewThread } from "../src/provider/types";
import {
	capVerdict,
	compileReview,
	emptyTally,
	type Finding,
	isAnswered,
	openPriorTally,
	parseUnifiedDiff,
	reviewTrigger,
	SPICE_DEFAULT,
	THRASH_REVIEW_MARKER,
	TIER_EMOJI,
	type Tier,
} from "../src/thrash/core";
import { parsePolicy, selectPhase } from "../src/thrash/policy";
import { pickSass, SASS_LINES, sassKey } from "../src/thrash/sass";

const FILES = parseUnifiedDiff(`diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,12 @@
 const a = 0;
+const l2 = 2;
+const l3 = 3;
+const l4 = 4;
+const l5 = 5;
+const l6 = 6;
+const l7 = 7;
+const l8 = 8;
+const l9 = 9;
+const l10 = 10;
+const l11 = 11;
+const l12 = 12;
`);

function finding(line: number, tier: Tier): Finding {
	return {
		path: "src/a.ts",
		line,
		side: "new",
		tier,
		title: `${tier} at ${line}`,
		body: `${tier} body`,
	};
}

function thread(
	line: number,
	tier: Tier,
	opts: { resolved?: boolean; author?: string; replyBy?: string } = {},
): ReviewThread {
	const author = opts.author ?? "thrashley[bot]";
	const comments = [
		{
			id: "1",
			author,
			body: `${TIER_EMOJI[tier]} **${tier}** earlier`,
			createdAt: "",
			diffHunk: "",
		},
	];
	if (opts.replyBy)
		comments.push({
			id: "2",
			author: opts.replyBy,
			body: "fixed",
			createdAt: "",
			diffHunk: "",
		});
	return {
		threadId: `t${line}`,
		resolved: opts.resolved ?? false,
		comments,
		commentId: "1",
		path: "src/a.ts",
		line,
	};
}

const NO_SWOT = { changed: "", strengths: [], opportunities: [] };
const BASE = {
	spice: SPICE_DEFAULT,
	commentOnly: false,
	existing: [] as ReviewThread[],
};

const STRICT_RELAXED = parsePolicy(`
maxComments: 10
phases:
  - name: strict
    through: 3
    block: { critical: 0, high: 0, medium: 0, low: 4 }
  - name: relaxed
    requiresClear: [critical, high]
    nits: false
    block: { critical: 0, high: 1 }
`);

const BLOCK_HIGH = parsePolicy(`
maxComments: 10
phases:
  - nits: false
    block: { critical: 0, high: 0 }
`);

describe("parsePolicy", () => {
	test("reads phases, limits and the comment cap", () => {
		expect(STRICT_RELAXED.maxComments).toBe(10);
		expect(
			STRICT_RELAXED.phases.map((p) => [p.name, p.through, p.nits]),
		).toEqual([
			["strict", 3, true],
			["relaxed", undefined, false],
		]);
		expect(STRICT_RELAXED.phases[1].requiresClear).toEqual([
			"critical",
			"high",
		]);
	});

	test("rejects an unknown tier and an empty phase list", () => {
		expect(() => parsePolicy("phases:\n  - block: { severe: 0 }\n")).toThrow(
			'phases.0.block: Unrecognized key: "severe"',
		);
		expect(() => parsePolicy("phases: []\n")).toThrow("phases: needs at least one phase");
	});
});

describe("selectPhase", () => {
	test("stays strict through round 3, then relaxes only when no critical or high is open", () => {
		const clear = emptyTally();
		const openHigh = { ...emptyTally(), high: 1 };
		expect(selectPhase(STRICT_RELAXED, 3, clear).name).toBe("strict");
		expect(selectPhase(STRICT_RELAXED, 4, clear).name).toBe("relaxed");
		expect(selectPhase(STRICT_RELAXED, 4, openHigh).name).toBe("strict");
	});
});

describe("thread state", () => {
	test("a reply from someone else answers a thread; the opener's own follow-up does not", () => {
		expect(isAnswered(thread(2, "high", { replyBy: "author" }))).toBe(true);
		expect(isAnswered(thread(2, "high", { replyBy: "thrashley" }))).toBe(false);
	});

	test("open prior findings count only this reviewer's unresolved, unanswered threads", () => {
		const existing = [
			thread(2, "high"),
			thread(3, "high", { resolved: true }),
			thread(4, "critical", { replyBy: "author" }),
			thread(5, "medium", { author: "copilot" }),
		];
		expect(openPriorTally(existing, "thrashley[bot]")).toEqual({
			...emptyTally(),
			high: 1,
		});
		expect(openPriorTally(existing).medium).toBe(1);
	});
});

describe("compileReview with a policy", () => {
	test("only critical or high blocks, and nits are not posted", () => {
		const findings = [
			finding(2, "medium"),
			finding(3, "low"),
			finding(4, "nit"),
		];
		const review = compileReview(
			FILES,
			{ ...NO_SWOT, findings },
			{ ...BASE, policy: BLOCK_HIGH, round: 1 },
		);
		expect(review.verdict).toBe("approve");
		expect(review.comments.map((c) => c.tier)).toEqual(["medium", "low"]);
	});

	test("an open earlier high blocks even when this round does not find it again", () => {
		const existing = [thread(9, "high")];
		const review = compileReview(
			FILES,
			{ ...NO_SWOT, findings: [] },
			{ ...BASE, existing, policy: BLOCK_HIGH, round: 2 },
		);
		expect(review.verdict).toBe("request_changes");
		expect(review.tally.high).toBe(1);
	});

	test("a re-found open finding counts once", () => {
		const existing = [thread(2, "high")];
		const findings = [finding(2, "high")];
		const review = compileReview(
			FILES,
			{ ...NO_SWOT, findings },
			{ ...BASE, existing, policy: BLOCK_HIGH, round: 2 },
		);
		expect(review.tally.high).toBe(1);
		expect(review.dropped.map((d) => d.reason)).toEqual(["duplicate"]);
	});

	test.each([
		{ prior: "low" as Tier, current: "high" as Tier, retained: "high" as Tier },
		{ prior: "high" as Tier, current: "low" as Tier, retained: "high" as Tier },
	])(
		"a re-found $current retains the higher severity of an earlier $prior",
		({ prior, current, retained }) => {
			const review = compileReview(
				FILES,
				{ ...NO_SWOT, findings: [finding(2, current)] },
				{
					...BASE,
					existing: [thread(2, prior)],
					policy: BLOCK_HIGH,
					reviewer: "thrashley",
				},
			);
			expect(review.verdict).toBe("request_changes");
			expect(review.tally).toEqual({ ...emptyTally(), [retained]: 1 });
			expect(review.comments).toEqual([]);
			expect(review.dropped.map((d) => d.reason)).toEqual(["duplicate"]);
		},
	);

	test.each([
		{ reverse: false, current: ["high"] as Tier[] },
		{ reverse: true, current: ["high"] as Tier[] },
		{ reverse: false, current: ["low", "high"] as Tier[] },
		{ reverse: true, current: ["high", "low"] as Tier[] },
	])("thread and finding order do not inflate the policy tally ($reverse, $current)", ({ reverse, current }) => {
		const existing = [thread(2, "low"), thread(2, "high")];
		if (reverse) existing.reverse();
		const review = compileReview(
			FILES,
			{ ...NO_SWOT, findings: current.map((tier) => finding(2, tier)) },
			{ ...BASE, existing, policy: parsePolicy("phases:\n  - block: { high: 1 }\n") },
		);
		expect(review.tally).toEqual({ ...emptyTally(), high: 1, low: 1 });
		expect(review.verdict).toBe("approve");
	});

	test("a re-found high blocks after someone answers its unresolved thread", () => {
		const review = compileReview(
			FILES,
			{ ...NO_SWOT, findings: [finding(2, "high")] },
			{
				...BASE,
				existing: [thread(2, "high", { replyBy: "author" })],
				policy: BLOCK_HIGH,
			},
		);
		expect(review.verdict).toBe("request_changes");
		expect(review.tally).toEqual({ ...emptyTally(), high: 1 });
		expect(review.comments).toEqual([]);
	});

	test("another reviewer's earlier high does not suppress or inflate the current finding", () => {
		const review = compileReview(
			FILES,
			{ ...NO_SWOT, findings: [finding(2, "high")] },
			{
				...BASE,
				existing: [thread(2, "critical", { author: "other-bot" })],
				policy: BLOCK_HIGH,
				reviewer: "thrashley",
			},
		);
		expect(review.verdict).toBe("request_changes");
		expect(review.tally).toEqual({ ...emptyTally(), high: 1 });
		expect(review.comments.map((c) => c.tier)).toEqual(["high"]);
	});

	test("a settled medium stays out of policy tallies", () => {
		const review = compileReview(
			FILES,
			{ ...NO_SWOT, findings: [finding(2, "medium")] },
			{
				...BASE,
				existing: [thread(2, "medium", { resolved: true })],
				policy: STRICT_RELAXED,
				round: 1,
			},
		);
		expect(review.verdict).toBe("approve");
		expect(review.tally).toEqual(emptyTally());
		expect(review.dropped.map((d) => d.reason)).toEqual(["settled"]);
	});

	test("a relaxed round allows one high and posts no nits", () => {
		const findings = [
			finding(2, "high"),
			finding(3, "medium"),
			finding(4, "nit"),
		];
		const review = compileReview(
			FILES,
			{ ...NO_SWOT, findings },
			{ ...BASE, policy: STRICT_RELAXED, round: 4 },
		);
		expect(review.phase).toBe("relaxed");
		expect(review.verdict).toBe("approve");
		expect(review.comments.map((c) => c.tier)).toEqual(["high", "medium"]);
		expect(review.body).toContain("**Round:** 4, relaxed");
	});

	test("a strict round blocks on a medium", () => {
		const review = compileReview(
			FILES,
			{ ...NO_SWOT, findings: [finding(2, "medium")] },
			{ ...BASE, policy: STRICT_RELAXED, round: 1 },
		);
		expect(review.verdict).toBe("request_changes");
		expect(review.reason).toBe("1 medium finding is open");
	});
});

describe("resolved threads", () => {
	test("a medium on a line with a resolved thread is not reposted; a high is", () => {
		const existing = [
			thread(2, "medium", { resolved: true }),
			thread(3, "high", { resolved: true }),
		];
		const findings = [finding(2, "medium"), finding(3, "high")];
		const review = compileReview(
			FILES,
			{ ...NO_SWOT, findings },
			{ ...BASE, existing },
		);
		expect(review.comments.map((c) => c.newLine)).toEqual([3]);
		expect(review.dropped.map((d) => d.reason)).toEqual(["settled"]);
		expect(review.body).toContain("1 finding on a line with a resolved thread");
	});
});

describe("comment cap", () => {
	test("keeps the highest tiers inline and lists the rest in the summary", () => {
		const tiers: Tier[] = ["low", "low", "high", "medium", "critical"];
		const findings = tiers.map((tier, i) => finding(i + 2, tier));
		const review = compileReview(
			FILES,
			{ ...NO_SWOT, findings },
			{ ...BASE, spice: 5, maxComments: 3 },
		);
		expect(review.comments.map((c) => c.tier)).toEqual([
			"high",
			"medium",
			"critical",
		]);
		expect(
			review.dropped.filter((d) => d.reason === "max-comments"),
		).toHaveLength(2);
		expect(review.body).toContain("2 findings over the comment cap");
		expect(review.tally.low).toBe(2);
	});
});

describe("capVerdict", () => {
	const blocked = {
		verdict: "request_changes" as const,
		reason: "1 high finding is open",
	};
	const approved = {
		verdict: "approve" as const,
		reason: "0 critical, 0 high",
	};

	test("auto keeps every verdict", () => {
		expect(capVerdict(blocked, undefined)).toEqual(blocked);
	});

	test("approve-only posts a block as a comment and says why", () => {
		expect(capVerdict(blocked, "approve")).toEqual({
			verdict: "comment",
			reason:
				"1 high finding is open; request changes is turned off, so this posts as a comment",
		});
		expect(capVerdict(approved, "approve")).toEqual(approved);
	});

	test("request-changes-only never approves", () => {
		expect(capVerdict(approved, "request_changes").verdict).toBe("comment");
	});
});

describe("summary", () => {
	test("a custom heading replaces the thrash heading and the hidden marker is kept", () => {
		const review = compileReview(
			FILES,
			{ ...NO_SWOT, findings: [] },
			{ ...BASE, heading: "Code Review", round: 2 },
		);
		expect(review.body.startsWith("## Code Review\n")).toBe(true);
		expect(review.body).toContain("**Round:** 2 ·");
		expect(review.body.endsWith(THRASH_REVIEW_MARKER)).toBe(true);
	});

	test("the action trigger is labeled", () => {
		expect(reviewTrigger(JSON.stringify({ origin: "action" }))).toBe("action");
		const review = compileReview(
			FILES,
			{ ...NO_SWOT, findings: [] },
			{ ...BASE, trigger: "action" },
		);
		expect(review.body).toContain("**Trigger:** Automatic (CI)");
	});
});

describe("sass", () => {
	test("adds exactly one line from the fixed list to the summary and never to a comment", () => {
		const findings = [finding(2, "high"), finding(3, "high")];
		const review = compileReview(
			FILES,
			{ ...NO_SWOT, findings },
			{ ...BASE, sassSeed: 1 },
		);
		const line = pickSass("request_changes", review.tally, 1);
		expect(review.sass).toBe(line);
		expect(SASS_LINES.high.map((l) => l.replace("{n}", "2"))).toContain(line);
		expect(
			review.body.split("\n").filter((l) => l === `_${line}_`),
		).toHaveLength(1);
		expect(review.comments.every((c) => !c.body.includes(line))).toBe(true);
	});

	test("does not change the verdict or the tally", () => {
		const findings = [finding(2, "high"), finding(3, "high")];
		const plain = compileReview(FILES, { ...NO_SWOT, findings }, BASE);
		const sassy = compileReview(
			FILES,
			{ ...NO_SWOT, findings },
			{ ...BASE, sassSeed: 7 },
		);
		expect([sassy.verdict, sassy.reason, sassy.tally]).toEqual([
			plain.verdict,
			plain.reason,
			plain.tally,
		]);
		expect(plain.sass).toBeUndefined();
	});

	test("the same seed picks the same line", () => {
		const tally = { ...emptyTally(), critical: 1 };
		expect(pickSass("request_changes", tally, 42)).toBe(
			pickSass("request_changes", tally, 42),
		);
	});

	test("keys a clean approval apart from an approval with notes", () => {
		expect(sassKey("approve", emptyTally())).toBe("clean");
		expect(sassKey("approve", { ...emptyTally(), low: 1 })).toBe("approve");
		expect(sassKey("request_changes", { ...emptyTally(), nit: 3 })).toBe(
			"blocked",
		);
	});

	test("no line names or addresses a person", () => {
		for (const line of Object.values(SASS_LINES).flat()) {
			expect(line).not.toMatch(
				/\b(he|she|they|him|her|dev|developer|author|idiot|stupid|lazy)\b/i,
			);
		}
	});
});

describe("review-round policy keys", () => {
	test("reads reconsiderAfter, improvements and maxImprovements", () => {
		const policy = parsePolicy("reconsiderAfter: 5\nimprovements: true\nmaxImprovements: 2\nphases:\n  - block: {}\n");
		expect(policy).toMatchObject({ reconsiderAfter: 5, improvements: true, maxImprovements: 2 });
	});

	test("leaves them unset by default and rejects a bad value", () => {
		const policy = parsePolicy("phases:\n  - block: {}\n");
		expect(policy.reconsiderAfter).toBeUndefined();
		expect(policy.improvements).toBeUndefined();
		expect(() => parsePolicy("improvements: 3\nphases:\n  - block: {}\n")).toThrow("improvements");
	});
});
