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
	test("renders a bullet list with link, verdict and failure code for a 3-PR stack", () => {
		expect(
			formatStackSummary([
				row(10, "approved"),
				row(11, "changes_requested"),
				row(12, { code: "CR-203" }),
			]),
		).toBe(
			'<p>Stacked review: 3 PRs</p><ul>' +
				'<li><a href="https://github.com/o/r/pull/10">r#10</a>: ✅ approved</li>' +
				'<li><a href="https://github.com/o/r/pull/11">r#11</a>: 🚧 changes requested</li>' +
				'<li><a href="https://github.com/o/r/pull/12">r#12</a>: ⚠️ CR-203</li>' +
				"</ul>",
		);
	});

	test("uses the singular header for one PR", () => {
		expect(formatStackSummary([row(10, "commented")])).toStartWith("<p>Stacked review: 1 PR</p>");
	});

	test("keeps stack order rather than sorting by outcome", () => {
		const html = formatStackSummary([row(30, "approved"), row(20, "changes_requested")]);
		expect(html.indexOf("r#30")).toBeLessThan(html.indexOf("r#20"));
	});

	test("labels a GitLab merge request by its project", () => {
		const html = formatStackSummary([
			{ number: 5, url: "https://gitlab.com/g/proj/-/merge_requests/5", outcome: "approved" },
		]);
		expect(html).toContain(">proj#5</a>");
	});

	test("escapes markup and quotes in the link and label", () => {
		const html = formatStackSummary([
			{ number: 1, url: 'https://github.com/o/r<x>&y/pull/1?a="b"', outcome: "approved" },
		]);
		expect(html).not.toContain("<x>");
		expect(html).toContain("&lt;x&gt;");
		expect(html).toContain("&amp;y");
		expect(html).toContain("&quot;b&quot;");
	});
});
