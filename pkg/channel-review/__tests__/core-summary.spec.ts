import { describe, expect, test } from "bun:test";
import {
	VERDICT_LABELS,
	aggregateOutcome,
	formatStackSummary,
} from "../src/summary";
import type { StackRow } from "../src/summary";

const url = (n: number): string => `https://github.com/o/r/pull/${n}`;
const row = (number: number, outcome: StackRow["outcome"]): StackRow => ({
	number,
	url: url(number),
	outcome,
});

describe("aggregateOutcome", () => {
	test("picks failure over every other outcome", () => {
		expect(
			aggregateOutcome([
				row(1, "approved"),
				row(2, "changes_requested"),
				row(3, { code: "CR-203" }),
				row(4, "commented"),
			]),
		).toBe("failure");
	});

	test("picks changesRequested over comment and approved", () => {
		expect(
			aggregateOutcome([
				row(1, "approved"),
				row(2, "commented"),
				row(3, "changes_requested"),
			]),
		).toBe("changesRequested");
	});

	test("picks comment over approved", () => {
		expect(
			aggregateOutcome([row(1, "approved"), row(2, "commented")]),
		).toBe("comment");
	});

	test("returns approved when every row is approved", () => {
		expect(aggregateOutcome([row(1, "approved"), row(2, "approved")])).toBe(
			"approved",
		);
	});

	test("ignores row order", () => {
		const rows = [row(1, { code: "CR-302" }), row(2, "approved")];
		expect(aggregateOutcome(rows)).toBe(aggregateOutcome([...rows].reverse()));
	});
});

describe("VERDICT_LABELS", () => {
	test("labels the three verdicts", () => {
		expect(VERDICT_LABELS).toEqual({
			approved: { emoji: "✅", word: "approved" },
			changes_requested: { emoji: "🚧", word: "changes requested" },
			commented: { emoji: "💬", word: "commented" },
		});
	});
});

describe("formatStackSummary", () => {
	const rows = [
		row(10, "approved"),
		row(11, "changes_requested"),
		row(12, "commented"),
	];

	test("renders the header line with the PR count", () => {
		expect(formatStackSummary(rows).split("\n")[0]).toBe(
			"Stacked review: 3 PRs",
		);
	});

	test("renders the singular header and one line for a single PR", () => {
		expect(formatStackSummary([row(10, "approved")]).split("\n")).toEqual([
			"Stacked review: 1 PR",
			`${VERDICT_LABELS.approved.emoji} #10 ${url(10)}`,
		]);
	});

	test("renders one line per PR in input order with the verdict emoji, number and link", () => {
		const lines = formatStackSummary(rows).split("\n");
		expect(lines.slice(1)).toEqual([
			`${VERDICT_LABELS.approved.emoji} #10 ${url(10)}`,
			`${VERDICT_LABELS.changes_requested.emoji} #11 ${url(11)}`,
			`${VERDICT_LABELS.commented.emoji} #12 ${url(12)}`,
		]);
	});

	test("keeps stack order rather than sorting by outcome", () => {
		const lines = formatStackSummary([
			row(30, "approved"),
			row(20, "changes_requested"),
		]).split("\n");
		expect(lines[1]).toContain("#30");
		expect(lines[2]).toContain("#20");
	});

	test("renders a failure row with the warning emoji and its CR code", () => {
		const lines = formatStackSummary([
			row(10, "approved"),
			row(11, { code: "CR-203" }),
		]).split("\n");
		expect(lines[2]).toBe(`⚠️ CR-203 #11 ${url(11)}`);
	});
});
