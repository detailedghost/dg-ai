import { describe, expect, it } from "bun:test";
import { computeGates, doMerge } from "./respond-core";

describe("computeGates", () => {
	it("reports nothing blocking for an empty payload", () => {
		const g = computeGates({});
		expect(g.allClear).toBe(true);
		expect(g.pendingDecisions).toEqual([]);
		expect(g.approvalBlocks).toBe(false);
		expect(g.permissionsBlock).toBe(false);
		expect(g.roundtableBlocks).toBe(false);
		expect(g.nextStepsBlocks).toBe(false);
	});

	it("clears the approval gate from payload.approved, not from a pending response", () => {
		const required = { approval: { required: true } };
		expect(computeGates({ ...required }).approvalBlocks).toBe(true);
		expect(computeGates({ ...required, approved: true }).approvalBlocks).toBe(false);
		expect(computeGates({ ...required, approved: true }).allClear).toBe(true);
	});

	it("treats next-steps feedback as blocking on its own, with no review flag set", () => {
		const g = computeGates({ next_steps: ["ship it"], next_steps_feedback_pending: true });
		expect(g.nextStepsBlocks).toBe(true);
		expect(g.nextStepsReviewRequired).toBe(false);
		expect(g.allClear).toBe(false);
	});

	it("keeps a required next-steps review blocking until approved", () => {
		const review = { next_steps_review: { required: true } };
		expect(computeGates({ ...review }).nextStepsBlocks).toBe(true);
		expect(computeGates({ ...review, next_steps_approved: true }).nextStepsBlocks).toBe(false);
	});

	it("counts pending decisions, treating tbd and missing answers as unanswered", () => {
		const g = computeGates({
			decisions: [{ question: "a", answer: "yes" }, { question: "b", answer: "tbd" }, { question: "c" }],
		});
		expect(g.pendingDecisions).toEqual([
			{ index: 1, question: "b" },
			{ index: 2, question: "c" },
		]);
	});

	it("blocks on ungranted permissions and counts them", () => {
		const g = computeGates({
			permissions: [
				{ key: "a", granted: true },
				{ key: "b", granted: false },
			],
		});
		expect(g.permissionsBlock).toBe(true);
		expect(g.permissionsUngranted).toBe(1);
		expect(computeGates({ permissions: [{ key: "a", granted: true }] }).permissionsBlock).toBe(false);
	});

	it("blocks on untriaged recommendations regardless of the interactive flag", () => {
		const payload = {
			roundtable_interactive: false,
			roundtable: [{ name: "design", recommendations: [{ text: "x" }, { text: "y", outcome: "accepted" }] }],
		};
		const g = computeGates(payload);
		expect(g.roundtableBlocks).toBe(true);
		expect(g.recommendationsPending).toBe(1);
		expect(g.recommendationsTriaged).toBe(1);
	});

	it("counts remaining open questions", () => {
		expect(computeGates({ open_questions: ["why?"] }).openQuestionsRemaining).toBe(1);
		expect(computeGates({ open_questions: ["why?"] }).allClear).toBe(false);
	});

	it("agrees with doMerge's all_clear on the same payload", () => {
		const cases: Record<string, unknown>[] = [
			{},
			{ approval: { required: true } },
			{ approval: { required: true }, approved: true },
			{ next_steps_feedback_pending: true },
			{ permissions: [{ key: "a", granted: false }] },
			{ decisions: [{ question: "a", answer: "tbd" }] },
			{ open_questions: ["q"] },
			{ roundtable: [{ name: "d", recommendations: [{ text: "x" }] }] },
		];
		for (const base of cases) {
			const forMerge = structuredClone(base);
			const summary = doMerge(forMerge, []);
			expect(computeGates(structuredClone(base)).allClear).toBe(summary.all_clear);
		}
	});
});

describe("doMerge pr_decision", () => {
	it("adds explicit guidance for regenerate decisions without user guidance", () => {
		const payload: Record<string, unknown> = {};

		const summary = doMerge(payload, [
			{
				type: "pr_decision",
				index: 0,
				answer: JSON.stringify({ action: "regenerate", body: "current body" }),
			},
		]);

		expect(payload.pr_decision).toEqual({
			action: "regenerate",
			body: "current body",
			guidance: "Generate a new PR message.",
		});
		expect(summary.all_clear).toBe(true);
	});

	it("preserves user guidance for regenerate decisions", () => {
		const payload: Record<string, unknown> = {};

		doMerge(payload, [
			{
				type: "pr_decision",
				index: 0,
				answer: JSON.stringify({
					action: "regenerate",
					body: "current body",
					guidance: "Make it shorter.",
				}),
			},
		]);

		expect(payload.pr_decision).toEqual({
			action: "regenerate",
			body: "current body",
			guidance: "Make it shorter.",
		});
	});

	it("does not add regenerate guidance to launch decisions", () => {
		const payload: Record<string, unknown> = {};

		doMerge(payload, [
			{
				type: "pr_decision",
				index: 0,
				answer: JSON.stringify({ action: "open", body: "current body" }),
			},
		]);

		expect(payload.pr_decision).toEqual({
			action: "open",
			body: "current body",
		});
	});
});

describe("doMerge permission_set", () => {
	const threePerms = () => [
		{ key: "a", granted: false },
		{ key: "b", granted: true },
		{ key: "c", granted: false },
	];

	it("grants every key in the list and revokes every key left out", () => {
		const payload: Record<string, unknown> = { permissions: threePerms() };

		doMerge(payload, [{ type: "permission_set", index: 0, answer: JSON.stringify(["a", "c"]) }]);

		expect(payload.permissions).toEqual([
			{ key: "a", granted: true },
			{ key: "b", granted: false },
			{ key: "c", granted: true },
		]);
	});

	it("clears the permissions gate once every key is selected", () => {
		const payload: Record<string, unknown> = { permissions: threePerms() };

		const summary = doMerge(payload, [{ type: "permission_set", index: 0, answer: JSON.stringify(["a", "b", "c"]) }]);

		expect(summary.all_clear).toBe(true);
	});

	it("keeps the gate closed while any key stays unselected", () => {
		const payload: Record<string, unknown> = { permissions: threePerms() };

		const summary = doMerge(payload, [{ type: "permission_set", index: 0, answer: JSON.stringify([]) }]);

		expect(summary.all_clear).toBe(false);
		expect(payload.permissions).toEqual([
			{ key: "a", granted: false },
			{ key: "b", granted: false },
			{ key: "c", granted: false },
		]);
	});

	it("leaves permissions untouched when the answer is not a JSON array", () => {
		const payload: Record<string, unknown> = { permissions: threePerms() };

		doMerge(payload, [{ type: "permission_set", index: 0, answer: "not json" }]);
		doMerge(payload, [{ type: "permission_set", index: 0, answer: JSON.stringify({ a: true }) }]);

		expect(payload.permissions).toEqual(threePerms());
	});

	it("lets a later submit override an earlier one", () => {
		const payload: Record<string, unknown> = { permissions: threePerms() };

		doMerge(payload, [{ type: "permission_set", index: 0, answer: JSON.stringify(["a", "b", "c"]) }]);
		doMerge(payload, [{ type: "permission_set", index: 0, answer: JSON.stringify(["b"]) }]);

		expect(payload.permissions).toEqual([
			{ key: "a", granted: false },
			{ key: "b", granted: true },
			{ key: "c", granted: false },
		]);
	});
});
