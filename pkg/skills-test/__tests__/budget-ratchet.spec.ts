import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	flatten,
	parseIncreases,
	ratchet,
	renderComment,
	run,
} from "../../../scripts/budget-ratchet";
import { makeTempDir, readRepoFile, removeTempDirs } from "./test-support";

afterEach(removeTempDirs);

const line = (b: string, o: number, n: number, why = "new feature") =>
	`Budget-Increase: ${b} ${o} -> ${n} because ${why}`;

describe("flatten", () => {
	test("keeps numeric leaves under slash-joined names and drops the rest", () => {
		expect(flatten("lean", { size: { a: { raw: 5 }, note: "x" }, n: 2 })).toEqual({
			"lean:size/a/raw": 5,
			"lean:n": 2,
		});
	});
});

describe("parseIncreases", () => {
	test("reads every well-formed line and ignores malformed ones", () => {
		const body = [
			"text",
			line("lean:size/a/raw", 100, 120),
			"Budget-Increase: broken line",
			"Budget-Increase: x 1 -> 2 because ",
			line("ram:hook/ms", 10, 11, "slower, on purpose"),
		].join("\r\n");
		expect(parseIncreases(body)).toEqual([
			{ budget: "lean:size/a/raw", old: 100, next: 120, reason: "new feature" },
			{ budget: "ram:hook/ms", old: 10, next: 11, reason: "slower, on purpose" },
		]);
	});
});

describe("ratchet", () => {
	const budgets = { "lean:a": 100 };

	test("passes when the measurement sits inside the slack", () => {
		const r = ratchet({ budgets, measured: { "lean:a": 96 }, prBody: "" });
		expect(r).toEqual({ failures: [], warnings: [], lowered: [] });
	});

	test("fails a measurement above budget", () => {
		const r = ratchet({ budgets, measured: { "lean:a": 101 }, prBody: "" });
		expect(r.failures).toHaveLength(1);
		expect(r.failures[0]).toContain("lean:a");
		expect(r.failures[0]).toContain("101");
		expect(r.failures[0]).toContain("100");
	});

	test("fails slack above 5 percent and names the budget to set", () => {
		const r = ratchet({ budgets, measured: { "lean:a": 90 }, prBody: "" });
		expect(r.failures).toHaveLength(1);
		expect(r.failures[0]).toContain("lean:a");
		expect(r.failures[0]).toContain("95");
	});

	test("passes slack of exactly 5 percent", () => {
		const r = ratchet({ budgets: { x: 105 }, measured: { x: 100 }, prBody: "" });
		expect(r.failures).toEqual([]);
	});

	test("allows 10 percent slack for latency budgets only", () => {
		const latency = ratchet({
			budgets: { "ram:hook/msBudget": 109 },
			measured: { "ram:hook/msBudget": 100 },
			prBody: "",
		});
		const size = ratchet({
			budgets: { "ram:hook/rssMb": 109 },
			measured: { "ram:hook/rssMb": 100 },
			prBody: "",
		});
		expect(latency.failures).toEqual([]);
		expect(size.failures).toHaveLength(1);
	});

	test("honors an explicit slackPct", () => {
		const r = ratchet({
			budgets: { x: 102 },
			measured: { x: 100 },
			prBody: "",
			slackPct: 1,
		});
		expect(r.failures).toHaveLength(1);
	});

	test("a raise with a matching Budget-Increase line passes", () => {
		const r = ratchet({
			budgets: { "lean:a": 120 },
			baseBudgets: { "lean:a": 100 },
			measured: { "lean:a": 118 },
			prBody: line("lean:a", 100, 120),
		});
		expect(r.failures).toEqual([]);
	});

	test("a raise without a line fails", () => {
		const r = ratchet({
			budgets: { "lean:a": 120 },
			baseBudgets: { "lean:a": 100 },
			measured: { "lean:a": 118 },
			prBody: "",
		});
		expect(r.failures).toHaveLength(1);
		expect(r.failures[0]).toContain("Budget-Increase");
	});

	test("a line whose numbers differ from the file fails", () => {
		const r = ratchet({
			budgets: { "lean:a": 120 },
			baseBudgets: { "lean:a": 100 },
			measured: { "lean:a": 118 },
			prBody: line("lean:a", 100, 150),
		});
		expect(r.failures).toHaveLength(1);
	});

	test("a lowered budget is reported and passes", () => {
		const r = ratchet({
			budgets: { "lean:a": 80 },
			baseBudgets: { "lean:a": 100 },
			measured: { "lean:a": 78 },
			prBody: "",
		});
		expect(r.failures).toEqual([]);
		expect(r.lowered).toEqual([{ budget: "lean:a", old: 100, next: 80 }]);
	});

	test("a PR that saves 3 MB fails until the budget drops", () => {
		const MB = 1024 * 1024;
		const before = ratchet({
			budgets: { "lean:size/linux-x64/rawBytes": 50 * MB },
			baseBudgets: { "lean:size/linux-x64/rawBytes": 50 * MB },
			measured: { "lean:size/linux-x64/rawBytes": 47 * MB },
			prBody: "",
		});
		const after = ratchet({
			budgets: { "lean:size/linux-x64/rawBytes": 49 * MB },
			baseBudgets: { "lean:size/linux-x64/rawBytes": 50 * MB },
			measured: { "lean:size/linux-x64/rawBytes": 47 * MB },
			prBody: "",
		});
		const lowered = ratchet({
			budgets: { "lean:size/linux-x64/rawBytes": Math.ceil(47 * MB * 1.05) },
			baseBudgets: { "lean:size/linux-x64/rawBytes": 50 * MB },
			measured: { "lean:size/linux-x64/rawBytes": 47 * MB },
			prBody: "",
		});
		expect(before.failures).toHaveLength(1);
		expect(after.failures).toHaveLength(1);
		expect(lowered.failures).toEqual([]);
	});

	test("warns for a budget with no measurement and for a stray line", () => {
		const r = ratchet({
			budgets: { a: 1, b: 1 },
			measured: { a: 1 },
			prBody: line("ghost", 1, 2),
		});
		expect(r.failures).toEqual([]);
		expect(r.warnings.some((w) => w.includes("b"))).toBe(true);
		expect(r.warnings.some((w) => w.includes("ghost"))).toBe(true);
	});

	test("does not mutate its inputs", () => {
		const input = {
			budgets: { a: 100 },
			baseBudgets: { a: 100 },
			measured: { a: 90 },
			prBody: "",
		};
		const copy = structuredClone(input);
		ratchet(input);
		expect(input).toEqual(copy);
	});
});

describe("run", () => {
	function repo(files: Record<string, unknown>): string {
		const root = makeTempDir("ratchet-");
		for (const [path, value] of Object.entries(files)) {
			mkdirSync(join(root, path, ".."), { recursive: true });
			writeFileSync(join(root, path), JSON.stringify(value));
		}
		return root;
	}

	test("reads the versioned budget files, skips missing ones and mirrors measurements", () => {
		const root = repo({
			"scripts/lean-budgets.json": { size: { t: { rawBytes: 100 } } },
			"native/budgets/hook.json": { totalBytes: 100 },
		});
		const measured = repo({
			"lean-budgets.json": { size: { t: { rawBytes: 120 } } },
			"hook.json": { totalBytes: 98 },
		});
		const result = run({
			root,
			measuredDir: measured,
			prBody: "",
			readBase: () => null,
		});
		expect(result.failures).toHaveLength(1);
		expect(result.failures[0]).toContain("lean-budgets:size/t/rawBytes");
		expect(result.rows.map((r) => r.budget).sort()).toEqual([
			"hook:totalBytes",
			"lean-budgets:size/t/rawBytes",
		]);
	});

	test("compares against the budget text readBase returns", () => {
		const root = repo({ "scripts/lean-budgets.json": { raw: 120 } });
		const measured = repo({ "lean-budgets.json": { raw: 118 } });
		const result = run({
			root,
			measuredDir: measured,
			prBody: "",
			readBase: () => JSON.stringify({ raw: 100 }),
		});
		expect(result.failures[0]).toContain("Budget-Increase");
	});

	test("renders one comment with a marker, the table and the growth text", () => {
		const root = repo({ "scripts/lean-budgets.json": { raw: 100 } });
		const measured = repo({ "lean-budgets.json": { raw: 99 } });
		const result = run({ root, measuredDir: measured, prBody: "", readBase: () => null });
		const text = renderComment(result, "mod-a grew 4 KB");
		expect(text).toContain("<!-- budget-ratchet -->");
		expect(text).toContain("lean-budgets:raw");
		expect(text).toContain("mod-a grew 4 KB");
	});
});

describe("budgets.yml", () => {
	const yml = readRepoFile(".github", "workflows", "budgets.yml");

	test("runs on every pull request without a paths filter", () => {
		expect(yml).toMatch(/^on:\n {2}pull_request:\n(?! {4}paths)/m);
	});

	test("keeps permissions minimal", () => {
		expect(yml).toMatch(/permissions:\n {2}contents: read\n {2}actions: read\n {2}pull-requests: write\n/);
		expect(yml).not.toMatch(/write-all|contents: write/);
	});

	test("reads the PR body from the event through an env var, never inline in a script", () => {
		expect(yml).toContain("PR_BODY: ${{ github.event.pull_request.body }}");
		expect(yml).not.toMatch(/run:[^\n]*\$\{\{ github\.event\.pull_request\.body/);
	});
});
