import { describe, expect, test } from "bun:test";
import { budgetMismatch, gateExit, judge, MB, parseBudgets, summarize } from "../judge";

const budget = { peakMB: 30, msBudget: 50, growthMB: 2 };
const sample = { peak: 20 * MB, ms: 40, p90: 45, p95: 48 };

describe("judge", () => {
	test("a sample inside every budget passes", () => {
		expect(judge(sample, budget, false)).toEqual({ over: false, slow: false, leaking: false });
	});

	test("a case over msBudget is marked SLOW", () => {
		expect(judge({ ...sample, ms: 51 }, budget, false)).toEqual({ over: false, slow: true, leaking: false });
	});

	test("a case without msBudget is never SLOW", () => {
		expect(judge({ ...sample, ms: 9999 }, { peakMB: 30 }, false).slow).toBe(false);
	});

	test("peak RSS over the budget is OVER and an ungated case never is", () => {
		expect(judge({ ...sample, peak: 31 * MB }, budget, false).over).toBe(true);
		expect(judge({ ...sample, peak: 31 * MB }, budget, true).over).toBe(false);
	});

	test("idle growth over growthMB is a leak", () => {
		expect(judge({ ...sample, growth: 3 * MB }, budget, false).leaking).toBe(true);
		expect(judge({ ...sample, growth: 2 * MB }, budget, false).leaking).toBe(false);
	});
});

describe("summarize", () => {
	test("reports the median, p90 and p95 of the timings and the median peak", () => {
		const samples = Array.from({ length: 20 }, (_, i) => ({ peak: (i + 1) * MB, ms: i + 1 }));
		expect(summarize(samples)).toEqual({ peak: 11 * MB, ms: 11, p90: 19, p95: 20 });
	});

	test("rejects an empty run", () => {
		expect(() => summarize([])).toThrow("no samples");
	});
});

describe("gateExit", () => {
	test("fails the run on linux when a case failed", () => {
		expect(gateExit("linux", true, 1)).toBe(1);
		expect(gateExit("linux", true, 0)).toBe(0);
		expect(gateExit("linux", false, 3)).toBe(0);
	});

	test("only reports on macOS and Windows", () => {
		expect(gateExit("darwin", true, 4)).toBe(0);
		expect(gateExit("win32", true, 4)).toBe(0);
	});
});

describe("parseBudgets", () => {
	const text = JSON.stringify({ version: 1, cases: { version: { peakMB: 24, msBudget: 30 } } });

	test("reads the cases", () => {
		expect(parseBudgets(text, "b.json").cases.version).toEqual({ peakMB: 24, msBudget: 30 });
	});

	test("names the file and case when a budget is not a positive number", () => {
		const bad = JSON.stringify({ version: 1, cases: { version: { peakMB: "24" } } });
		expect(() => parseBudgets(bad, "b.json")).toThrow('b.json: case "version" peakMB must be a positive number');
		const slow = JSON.stringify({ version: 1, cases: { version: { peakMB: 1, msBudget: 0 } } });
		expect(() => parseBudgets(slow, "b.json")).toThrow('case "version" msBudget must be a positive number');
	});

	test("rejects an unknown version", () => {
		expect(() => parseBudgets('{"version":2,"cases":{}}', "b.json")).toThrow("b.json: version must be 1");
	});
});

describe("budgetMismatch", () => {
	const budgets = parseBudgets(JSON.stringify({ version: 1, cases: { a: { peakMB: 1 }, b: { peakMB: 1 } } }), "b.json");

	test("is empty when cases and budgets match", () => {
		expect(budgetMismatch(["a", "b"], budgets)).toEqual([]);
	});

	test("names a case without a budget and a budget without a case", () => {
		expect(budgetMismatch(["a", "c"], budgets)).toEqual(['case "c" has no budget in ram-budgets.json', 'budget "b" has no case']);
	});
});
