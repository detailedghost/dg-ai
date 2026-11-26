import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	flatten,
	lowerBudgets,
	lowerTree,
	parseIncreases,
	parseRemovals,
	ratchet,
	renderComment,
	run,
	runLower,
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

describe("parseRemovals", () => {
	test("reads the budget names of well-formed lines only", () => {
		const body = ["Budget-Removal: a:b/c because gone", "Budget-Removal: x because ", "Budget-Removal: broken"].join("\n");
		expect(parseRemovals(body)).toEqual(["a:b/c"]);
	});
});

describe("ratchet", () => {
	const budgets = { "lean:a": 100 };

	test("a budget key removed from the head fails without a Budget-Removal line", () => {
		const r = ratchet({ budgets: {}, baseBudgets: { "lean:a": 100 }, measured: {}, prBody: "" });
		expect(r.failures).toHaveLength(1);
		expect(r.failures[0]).toContain("lean:a");
		expect(r.failures[0]).toContain("Budget-Removal: lean:a because <reason>");
	});

	test("a matching Budget-Removal line allows the removal", () => {
		const r = ratchet({
			budgets: {},
			baseBudgets: { "lean:a": 100 },
			measured: {},
			prBody: "Budget-Removal: lean:a because the case was deleted",
		});
		expect(r.failures).toEqual([]);
	});

	test("a Budget-Removal line for another key does not allow the removal", () => {
		const r = ratchet({
			budgets: {},
			baseBudgets: { "lean:a": 100 },
			measured: {},
			prBody: "Budget-Removal: lean:b because nope",
		});
		expect(r.failures).toHaveLength(1);
	});

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

	test("warns on slack above 5 percent, names the budget to set, and does not fail", () => {
		const r = ratchet({ budgets, measured: { "lean:a": 90 }, prBody: "" });
		expect(r.failures).toEqual([]);
		expect(r.warnings).toHaveLength(1);
		expect(r.warnings[0]).toContain("lean:a");
		expect(r.warnings[0]).toContain("94");
	});

	test("passes slack of exactly 5 percent", () => {
		const r = ratchet({ budgets: { x: 105 }, measured: { x: 100 }, prBody: "" });
		expect(r.failures).toEqual([]);
	});

	test("gates latency budgets on overruns only", () => {
		const latency = ratchet({
			budgets: { "ram:hook/msBudget": 200 },
			measured: { "ram:hook/msBudget": 100 },
			prBody: "",
		});
		const size = ratchet({
			budgets: { "ram:hook/rssMb": 109 },
			measured: { "ram:hook/rssMb": 100 },
			prBody: "",
		});
		expect(latency.failures).toEqual([]);
		expect(latency.warnings).toEqual([]);
		expect(size.failures).toEqual([]);
		expect(size.warnings).toHaveLength(1);
	});

	test("still fails a latency overrun", () => {
		const r = ratchet({
			budgets: { "native:hooks/p50Ms": 5 },
			measured: { "native:hooks/p50Ms": 5.2 },
			prBody: "",
		});
		expect(r.failures).toHaveLength(1);
		expect(r.failures[0]).toContain("over the budget");
	});

	test("names a nonzero budget to set for a key under 1", () => {
		const r = ratchet({ budgets: { "ram:idle/anonMB": 1.14 }, measured: { "ram:idle/anonMB": 0.91 }, prBody: "" });
		expect(r.warnings).toHaveLength(1);
		expect(r.warnings[0]).toContain("lower the budget to 0.955");
	});

	test("gates growth budgets on overruns only", () => {
		const slack = ratchet({ budgets: { "ram:daemon/growthMB": 4 }, measured: { "ram:daemon/growthMB": 0.91 }, prBody: "" });
		const over = ratchet({ budgets: { "ram:daemon/growthMB": 4 }, measured: { "ram:daemon/growthMB": 4.2 }, prBody: "" });
		expect(slack.failures).toEqual([]);
		expect(slack.warnings).toEqual([]);
		expect(over.failures).toHaveLength(1);
	});

	test("honors an explicit slackPct", () => {
		const r = ratchet({
			budgets: { x: 102 },
			measured: { x: 100 },
			prBody: "",
			slackPct: 1,
		});
		expect(r.failures).toEqual([]);
		expect(r.warnings).toHaveLength(1);
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

	test("a PR that saves 3 MB passes and warns until the budget drops", () => {
		const MB = 1024 * 1024;
		const before = ratchet({
			budgets: { "lean:size/linux-x64/rawBytes": 50 * MB },
			baseBudgets: { "lean:size/linux-x64/rawBytes": 50 * MB },
			measured: { "lean:size/linux-x64/rawBytes": 47 * MB },
			prBody: "",
		});
		const after = ratchet({
			budgets: { "lean:size/linux-x64/rawBytes": 49.5 * MB },
			baseBudgets: { "lean:size/linux-x64/rawBytes": 50 * MB },
			measured: { "lean:size/linux-x64/rawBytes": 47 * MB },
			prBody: "",
		});
		const lowered = ratchet({
			budgets: { "lean:size/linux-x64/rawBytes": Math.floor(47 * MB * 1.05) },
			baseBudgets: { "lean:size/linux-x64/rawBytes": 50 * MB },
			measured: { "lean:size/linux-x64/rawBytes": 47 * MB },
			prBody: "",
		});
		expect(before.failures).toEqual([]);
		expect(before.warnings).toHaveLength(1);
		expect(after.failures).toEqual([]);
		expect(after.warnings).toHaveLength(1);
		expect(lowered.failures).toEqual([]);
		expect(lowered.warnings).toEqual([]);
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
			"native/bench/Dg.Bench/budgets/bench-linux-x64.json": { ipcWarmP50Ms: 1 },
		});
		const measured = repo({
			"lean-budgets.json": { size: { t: { rawBytes: 120 } } },
			"hook.json": { totalBytes: 98 },
			"bench-linux-x64.json": { ipcWarmP50Ms: 1 },
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
			"bench-linux-x64:ipcWarmP50Ms",
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

	test("a budget file deleted from the head fails through its base text", () => {
		const root = repo({});
		const measured = repo({});
		const result = run({
			root,
			measuredDir: measured,
			prBody: "",
			readBase: (path) => (path === "scripts/lean-budgets.json" ? JSON.stringify({ raw: 100 }) : null),
		});
		expect(result.failures).toHaveLength(1);
		expect(result.failures[0]).toContain("lean-budgets:raw");
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

	test("downloads the bench measurements from the native-bench run on the head SHA", () => {
		expect(yml).toContain("--workflow native-bench.yml");
		expect(yml).toContain("--pattern 'bench-measurements-*'");
	});
});

describe("lowerTree", () => {
	const tree = { version: 1, cases: { hook: { rssMb: 110, msBudget: 40, growthMB: 4 }, tight: { rssMb: 104 } } };
	const measured = {
		"ram:cases/hook/rssMb": 100,
		"ram:cases/hook/msBudget": 10,
		"ram:cases/hook/growthMB": 1,
		"ram:cases/tight/rssMb": 100,
	};

	test("lowers a level budget with slack over 5 percent to the measured value plus 5 percent", () => {
		const r = lowerTree({ prefix: "ram", tree, measured });
		expect(r.lowered).toEqual([{ budget: "ram:cases/hook/rssMb", old: 110, next: 105 }]);
		expect((r.tree as typeof tree).cases.hook.rssMb).toBe(105);
	});

	test("leaves latency and growth ceilings, budgets inside the slack, and unmeasured keys", () => {
		const r = lowerTree({ prefix: "ram", tree, measured });
		const out = r.tree as typeof tree;
		expect(out.cases.hook.msBudget).toBe(40);
		expect(out.cases.hook.growthMB).toBe(4);
		expect(out.cases.tight.rssMb).toBe(104);
		expect(out.version).toBe(1);
	});

	test("never raises a budget", () => {
		const r = lowerTree({ prefix: "ram", tree: { a: 100 }, measured: { "ram:a": 120 } });
		expect(r.lowered).toEqual([]);
		expect(r.tree).toEqual({ a: 100 });
	});
});

describe("lowerBudgets", () => {
	test("rewrites only the budget files that have slack, with tab indent", () => {
		const root = makeTempDir("ratchet-lower-");
		mkdirSync(join(root, "scripts"));
		mkdirSync(join(root, "m"));
		writeFileSync(join(root, "scripts/ram-budgets.json"), JSON.stringify({ a: { rssMb: 200 } }, null, "\t"));
		writeFileSync(join(root, "scripts/lean-budgets.json"), JSON.stringify({ b: 10 }, null, "\t"));
		writeFileSync(join(root, "m/ram-budgets.json"), JSON.stringify({ a: { rssMb: 100 } }));
		writeFileSync(join(root, "m/lean-budgets.json"), JSON.stringify({ b: 10 }));
		const lowered = lowerBudgets({ root, measuredDir: join(root, "m") });
		expect(lowered).toEqual([{ budget: "ram-budgets:a/rssMb", old: 200, next: 105 }]);
		expect(readFileSync(join(root, "scripts/ram-budgets.json"), "utf8")).toBe('{\n\t"a": {\n\t\t"rssMb": 105\n\t}\n}\n');
	});
});

describe("runLower", () => {
	test("lowers a native budget file, leaves an unmeasured one, and writes the table", () => {
		const root = makeTempDir("ratchet-runlower-");
		mkdirSync(join(root, "native/budgets"), { recursive: true });
		mkdirSync(join(root, "m"));
		writeFileSync(join(root, "native/budgets/native-ram-linux-x64.json"), JSON.stringify({ version: { rssBytes: 1000 } }, null, "\t"));
		writeFileSync(join(root, "native/budgets/native-ram-win-x64.json"), JSON.stringify({ version: { rssBytes: 1000 } }, null, "\t"));
		writeFileSync(join(root, "m/native-ram-linux-x64.json"), JSON.stringify({ version: { rssBytes: 800 } }));
		const loweredPath = join(root, "lowered.md");
		const lowered = runLower({ root, measuredDir: join(root, "m"), loweredPath });
		expect(lowered).toEqual([{ budget: "native-ram-linux-x64:version/rssBytes", old: 1000, next: 840 }]);
		expect(readFileSync(loweredPath, "utf8")).toContain("| native-ram-linux-x64:version/rssBytes | 1000 | 840 |");
		expect(JSON.parse(readFileSync(join(root, "native/budgets/native-ram-win-x64.json"), "utf8"))).toEqual({ version: { rssBytes: 1000 } });
	});

	test("writes an empty table file when nothing is lowered", () => {
		const root = makeTempDir("ratchet-runlower-empty-");
		const loweredPath = join(root, "lowered.md");
		expect(runLower({ root, measuredDir: join(root, "m"), loweredPath })).toEqual([]);
		expect(readFileSync(loweredPath, "utf8")).toBe("");
	});
});
