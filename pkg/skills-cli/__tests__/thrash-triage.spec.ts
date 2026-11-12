import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EXIT } from "../src/utils/legacy-command";
import * as cliFixtures from "./cli-fixtures";
import { makeTempDir } from "./git-repo-fixtures";
import { type AgentOutput, type Finding, type Tier, VERDICT_LIMITS } from "../src/thrash/core";
import {
	applyVerdicts,
	type ConsolidateInput,
	inVerifyScope,
	mergeChunks,
	parseConsolidated,
	parseConsolidateInput,
	readVerdictTexts,
	removeTriageFiles,
	resolveCompileFindings,
	triagePaths,
	VERIFY_TASK_CAP,
	type VerifyTask,
} from "../src/thrash/triage";

const paths = triagePaths("/tmp/x/slug.diff");

function finding(over: Partial<Finding> = {}): Finding {
	return { path: "a.ts", line: 1, side: "new", tier: "medium", title: "t", body: "b", ...over };
}

function output(findings: Finding[]): AgentOutput {
	return { changed: "c", strengths: [], opportunities: [], findings };
}

function distinct(count: number, tier: Tier, start = 0): Finding[] {
	return Array.from({ length: count }, (_, i) => finding({ tier, line: start + i + 1, body: `${tier} body ${start + i}` }));
}

function merge(
	chunks: Array<Finding[] | { findings: Finding[]; contextPath: string | null; annotatedPath?: string }>,
	spice = 3,
) {
	return mergeChunks(
		chunks.map((chunk, i) => ({
			id: i + 1,
			output: output(Array.isArray(chunk) ? chunk : chunk.findings),
			contextPath: Array.isArray(chunk) ? null : chunk.contextPath,
			annotatedPath: Array.isArray(chunk) ? null : (chunk.annotatedPath ?? null),
		})),
		{ spice, paths },
	);
}

describe("triagePaths", () => {
	test("derives absolute sibling paths from the diff path", () => {
		expect(paths.merged).toBe("/tmp/x/slug.merged.json");
		expect(paths.tasks).toBe("/tmp/x/slug.verify.tasks.json");
		expect(paths.taskPath("c1-2")).toBe("/tmp/x/slug.verify.task.c1-2.json");
		expect(paths.verdictPath("c1-2")).toBe("/tmp/x/slug.verdict.c1-2.json");
		expect(paths.verdictPrefix).toBe("/tmp/x/slug.verdict.");
		expect(paths.taskPrefix).toBe("/tmp/x/slug.verify.task.");
		expect(paths.verdicts).toBe("/tmp/x/slug.verdicts.json");
		expect(paths.consolidateInput).toBe("/tmp/x/slug.consolidate.input.json");
		expect(paths.consolidated).toBe("/tmp/x/slug.consolidated.md");
	});
});

describe("mergeChunks ids", () => {
	test("gives c<chunk>-<n> ids per chunk and replaces a reviewer id", () => {
		const { merged } = merge([
			[finding({ line: 1, body: "one", id: "zzz" }), finding({ line: 2, body: "two" })],
			[finding({ path: "b.ts", body: "three" })],
		]);
		expect(merged.findings.map((f) => f.id)).toEqual(["c1-1", "c1-2", "c2-1"]);
	});

	test("numbers by position in the chunk file even when a cross-chunk duplicate drops", () => {
		const dup = finding({ body: "same" });
		const { merged } = merge([[dup], [finding({ line: 5, body: "other" }), dup]]);
		expect(merged.findings.map((f) => f.id)).toEqual(["c1-1", "c2-1"]);
	});
});

describe("verify scope", () => {
	const tiers: Tier[] = ["critical", "high", "medium", "low", "nit"];
	const scoped = (spice: number) => {
		const { tasks } = merge([tiers.map((tier, i) => finding({ tier, line: i + 1, body: tier }))], spice);
		return tasks.map((task) => task.tier);
	};

	test("medium gets a task and low does not at spice 2", () => {
		expect(scoped(2)).toEqual(["critical", "high", "medium"]);
	});

	test("low gets a task at spice 5", () => {
		expect(scoped(5)).toEqual(["critical", "high", "medium", "low"]);
	});

	test("a nit and an improvement get none at every spice", () => {
		for (const spice of [1, 2, 3, 4, 5]) {
			const { tasks } = merge(
				[[finding({ tier: "nit", body: "n" }), finding({ tier: "high", kind: "improvement", line: 2, body: "i" })]],
				spice,
			);
			expect(tasks).toEqual([]);
		}
	});

	test("agrees with VERDICT_LIMITS at spice 1 to 5", () => {
		for (const spice of [1, 2, 3, 4, 5]) {
			const limits = VERDICT_LIMITS[spice];
			for (const tier of tiers) {
				const expected = tier !== "nit" && (["critical", "high", "medium"].includes(tier) || tier in limits);
				expect(inVerifyScope(finding({ tier }), spice)).toBe(expected);
			}
		}
	});
});

describe("mergeChunks tasks", () => {
	test("20 findings in scope give 16 tasks and 4 medium ids in overCap", () => {
		const { tasks, overCap, merged } = merge([[...distinct(2, "critical"), ...distinct(6, "high", 10), ...distinct(12, "medium", 20)]]);
		expect(tasks).toHaveLength(16);
		const byId = new Map(merged.findings.map((f) => [f.id, f.tier]));
		const taskTiers = tasks.map((task) => task.tier);
		expect(taskTiers.filter((tier) => tier === "critical")).toHaveLength(2);
		expect(taskTiers.filter((tier) => tier === "high")).toHaveLength(6);
		expect(overCap).toHaveLength(4);
		expect(overCap.every((id) => byId.get(id) === "medium")).toBe(true);
		expect(taskTiers.slice(0, 2)).toEqual(["critical", "critical"]);
	});

	test("16 counted medium findings and 1 preExisting medium give 16 tasks and the preExisting id in overCap", () => {
		const { tasks, overCap, merged } = merge([[finding({ preExisting: true, line: 99, body: "pre" }), ...distinct(16, "medium")]]);
		const pre = merged.findings.find((f) => f.preExisting)?.id;
		expect(tasks).toHaveLength(VERIFY_TASK_CAP);
		expect(overCap).toEqual([pre as string]);
	});

	test("orders ties by chunk id then position", () => {
		const { tasks } = merge([[finding({ body: "a" })], [finding({ line: 2, body: "b" })]]);
		expect(tasks.map((task) => task.id)).toEqual(["c1-1", "c2-1"]);
	});

	test("every verdictPath is unique and absolute", () => {
		const { tasks } = merge([distinct(3, "high"), distinct(2, "medium", 10)]);
		const set = new Set(tasks.map((task) => task.verdictPath));
		expect(set.size).toBe(tasks.length);
		for (const task of tasks) expect(task.verdictPath).toBe(paths.verdictPath(task.id));
	});

	test("bundleContextPath is null with no contextPath and the path otherwise", () => {
		const { tasks } = merge([
			distinct(1, "high"),
			{ findings: distinct(1, "high", 10), contextPath: "/abs/chunk2.bundle.md" },
		]);
		expect(tasks.find((task) => task.id === "c1-1")?.bundleContextPath).toBeNull();
		expect(tasks.find((task) => task.id === "c2-1")?.bundleContextPath).toBe("/abs/chunk2.bundle.md");
	});

	test("a task carries its finding fields and evidence", () => {
		const evidence = [{ path: "x.ts", line: 3, note: "n" }];
		const { tasks } = merge([[finding({ tier: "high", title: "T", body: "B", evidence })]]);
		expect(tasks[0]).toEqual({
			id: "c1-1",
			path: "a.ts",
			line: 1,
			tier: "high",
			title: "T",
			body: "B",
			evidence,
			side: "new",
			diffPath: null,
			bundleContextPath: null,
			verdictPath: paths.verdictPath("c1-1"),
		});
	});

	test("a task carries the side and the annotated diff path of its chunk", () => {
		const { tasks } = merge([
			{ findings: [finding({ tier: "high", side: "old" })], contextPath: null, annotatedPath: "/abs/chunk1.annotated.diff" },
			distinct(1, "high", 10),
		]);
		expect(tasks.find((task) => task.id === "c1-1")).toMatchObject({ side: "old", diffPath: "/abs/chunk1.annotated.diff" });
		expect(tasks.find((task) => task.id === "c2-1")).toMatchObject({ side: "new", diffPath: null });
	});

	test("no finding in scope gives empty lists", () => {
		const { tasks, overCap } = merge([[finding({ tier: "low" })]], 3);
		expect({ tasks, overCap }).toEqual({ tasks: [], overCap: [] });
	});
});

describe("applyVerdicts", () => {
	function setup(findings: Finding[], overCapIds: string[] = []) {
		const { merged, tasks, overCap } = merge([findings]);
		return { merged, tasks, overCap: [...overCap, ...overCapIds] };
	}

	function verdictText(id: string, rest: Record<string, unknown>): string {
		return JSON.stringify({ id, reason: "r", ...rest });
	}

	function run(base: ReturnType<typeof setup>, texts: Record<string, string | null>) {
		return applyVerdicts({ ...base, verdictTexts: new Map(Object.entries(texts)) });
	}

	test("confirmed, adjusted, rejected and one missing verdict", () => {
		const base = setup(distinct(4, "high"));
		const result = run(base, {
			"c1-1": verdictText("c1-1", { verdict: "confirmed" }),
			"c1-2": verdictText("c1-2", { verdict: "adjusted", tier: "medium", evidence: [{ path: "e.ts", line: null, note: "n" }] }),
			"c1-3": verdictText("c1-3", { verdict: "rejected", reason: "not real" }),
			"c1-4": null,
		});
		expect(result.input.findings).toHaveLength(3);
		expect(result.input.findings.find((f) => f.id === "c1-2")?.tier).toBe("medium");
		expect(result.input.findings.find((f) => f.id === "c1-2")?.evidence).toEqual([{ path: "e.ts", line: null, note: "n" }]);
		expect(result.input.rejected).toHaveLength(1);
		expect(result.input.rejected[0]).toMatchObject({ id: "c1-3", reason: "not real" });
		expect(result.input.unverified).toEqual(["c1-4"]);
		expect(result.counts).toEqual({ confirmed: 1, adjusted: 1, rejected: 1, unverified: 1 });
		expect(result.verdicts.map((v) => v.id)).toEqual(["c1-1", "c1-2", "c1-3"]);
	});

	test("adjusted can raise a tier", () => {
		const base = setup([finding({ tier: "medium" })]);
		const result = run(base, { "c1-1": verdictText("c1-1", { verdict: "adjusted", tier: "critical" }) });
		expect(result.input.findings[0].tier).toBe("critical");
	});

	test("appends adjusted evidence to existing evidence and cleans it through parseEvidence", () => {
		const base = setup([finding({ tier: "high", evidence: [{ path: "x.ts", line: 1, note: "old" }] })]);
		const result = run(base, {
			"c1-1": verdictText("c1-1", {
				verdict: "adjusted",
				tier: "high",
				evidence: [{ path: "`y.ts`", line: 2, note: "a\nb" }, { path: "", note: "dropped" }],
			}),
		});
		expect(result.input.findings[0].evidence).toEqual([
			{ path: "x.ts", line: 1, note: "old" },
			{ path: "y.ts", line: 2, note: "a b" },
		]);
	});

	test("appends confirmed evidence once and skips entries that already exist", () => {
		const base = setup([finding({ tier: "high", evidence: [{ path: "x.ts", line: 1, note: "old" }] })]);
		const result = run(base, {
			"c1-1": verdictText("c1-1", {
				verdict: "confirmed",
				evidence: [{ path: "x.ts", line: 1, note: "old" }, { path: "y.ts", line: 2, note: "new" }],
			}),
		});
		expect(result.input.findings[0].tier).toBe("high");
		expect(result.input.findings[0].evidence).toEqual([
			{ path: "x.ts", line: 1, note: "old" },
			{ path: "y.ts", line: 2, note: "new" },
		]);
	});

	test("keeps every overCap finding and lists its id as unverified", () => {
		const { merged, tasks, overCap } = merge([distinct(18, "medium")]);
		const texts = Object.fromEntries(tasks.map((task) => [task.id, verdictText(task.id, { verdict: "confirmed" })]));
		const result = applyVerdicts({ merged, tasks, overCap, verdictTexts: new Map(Object.entries(texts)) });
		expect(result.input.findings).toHaveLength(18);
		expect(result.input.unverified).toEqual(overCap);
		expect(result.counts).toEqual({ confirmed: 16, adjusted: 0, rejected: 0, unverified: 2 });
	});

	test("a verdict file that is not JSON or has a different id is unverified and the finding stays", () => {
		const base = setup(distinct(2, "high"));
		const result = run(base, { "c1-1": "not json", "c1-2": verdictText("c1-9", { verdict: "rejected" }) });
		expect(result.input.findings).toHaveLength(2);
		expect(result.input.rejected).toEqual([]);
		expect(result.input.unverified).toEqual(["c1-1", "c1-2"]);
	});

	test("adjusted with an unknown tier or no tier is unverified and keeps its tier", () => {
		const base = setup(distinct(2, "high"));
		const result = run(base, {
			"c1-1": verdictText("c1-1", { verdict: "adjusted", tier: "urgent" }),
			"c1-2": verdictText("c1-2", { verdict: "adjusted" }),
		});
		expect(result.input.findings.map((f) => f.tier)).toEqual(["high", "high"]);
		expect(result.input.unverified).toEqual(["c1-1", "c1-2"]);
		expect(result.counts).toEqual({ confirmed: 0, adjusted: 0, rejected: 0, unverified: 2 });
	});

	test("a verdict word outside the three is unverified", () => {
		const base = setup(distinct(1, "high"));
		const result = run(base, { "c1-1": verdictText("c1-1", { verdict: "maybe" }) });
		expect(result.input.unverified).toEqual(["c1-1"]);
		expect(result.verdicts).toEqual([]);
	});

	test("a verdict for an id that is not a task is ignored", () => {
		const base = setup(distinct(1, "high"));
		const result = run(base, { "c1-1": verdictText("c1-1", { verdict: "confirmed" }), "c7-7": verdictText("c7-7", { verdict: "rejected" }) });
		expect(result.input.findings).toHaveLength(1);
		expect(result.counts.rejected).toBe(0);
	});

	test("with no verdict files the consolidate input still carries every finding and summary", () => {
		const base = setup(distinct(2, "high"));
		const result = run(base, {});
		expect(result.input.findings).toHaveLength(2);
		expect(result.input.changed).toBe("c");
		expect(result.input.unverified).toEqual(["c1-1", "c1-2"]);
		expect(result.verdicts).toEqual([]);
	});

	test("is idempotent", () => {
		const base = setup(distinct(3, "high"));
		const texts = {
			"c1-1": verdictText("c1-1", { verdict: "adjusted", tier: "low" }),
			"c1-2": verdictText("c1-2", { verdict: "rejected" }),
		};
		expect(run(base, texts)).toEqual(run(base, texts));
		expect(base.merged.findings.map((f) => f.tier)).toEqual(["high", "high", "high"]);
	});
});

describe("triage files", () => {
	test("readVerdictTexts returns null for a missing file and removeTriageFiles clears every slug file", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "triage-"));
		try {
			const diff = path.join(dir, "s.diff");
			const p = triagePaths(diff);
			writeFileSync(p.verdictPath("c1-1"), "{}");
			writeFileSync(p.taskPath("c1-1"), "{}");
			for (const file of [p.merged, p.tasks, p.verdicts, p.consolidateInput, p.consolidated]) writeFileSync(file, "x");
			writeFileSync(path.join(dir, "s.plan.json"), "{}");
			writeFileSync(path.join(dir, "other.verdict.c1-1.json"), "{}");
			mkdirSync(path.join(dir, "sub"));
			const task = { id: "c1-1", verdictPath: p.verdictPath("c1-1") } as VerifyTask;
			const gone = { id: "c1-2", verdictPath: p.verdictPath("c1-2") } as VerifyTask;
			expect(readVerdictTexts([task, gone])).toEqual(new Map([["c1-1", "{}"], ["c1-2", null]]));
			removeTriageFiles(diff);
			const left = readdirSync(dir);
			expect([...left].sort()).toEqual(["other.verdict.c1-1.json", "s.plan.json", "sub"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("removeTriageFiles without a folder", () => {
	test("returns without throwing when the scratch folder is gone", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "triage-"));
		rmSync(dir, { recursive: true, force: true });
		expect(() => removeTriageFiles(path.join(dir, "s.diff"))).not.toThrow();
	});
});

describe("parseConsolidateInput", () => {
	test("rejects a finding without a valid tier", () => {
		const text = JSON.stringify({ findings: [{ path: "a.ts", line: 1, body: "b" }] });
		expect(() => parseConsolidateInput(text)).toThrow("unknown tier");
	});

	test("keeps ids, evidence and reasons through a round trip", () => {
		const text = JSON.stringify({
			findings: [finding({ id: "c1-1", evidence: [{ path: "a.ts", line: 2, note: "n" }] })],
			rejected: [{ ...finding({ id: "c1-2" }), reason: "no" }],
			unverified: ["c1-1"],
		});
		const parsed = parseConsolidateInput(text);
		expect(parsed.findings[0]).toMatchObject({ id: "c1-1", evidence: [{ path: "a.ts", line: 2, note: "n" }] });
		expect(parsed.rejected[0]).toMatchObject({ id: "c1-2", reason: "no" });
		expect(parsed.unverified).toEqual(["c1-1"]);
	});
});

describe("resolveCompileFindings", () => {
	const a = finding({ id: "c1-1", tier: "high", path: "a.ts", line: 4, title: "In A", body: "orig A", class: "null-deref" });
	const b = finding({ id: "c1-2", tier: "low", path: "b.ts", line: 2, title: "In B", body: "orig B", tag: "t" });
	const input = (over: Partial<ConsolidateInput> = {}): ConsolidateInput => ({
		changed: "in changed",
		strengths: ["in s"],
		opportunities: ["in o"],
		findings: [a, b],
		rejected: [],
		unverified: [],
		...over,
	});
	const chunk = output([finding({ body: "chunk" })]);
	const resolve = (consolidated: unknown, inp: ConsolidateInput | null) =>
		resolveCompileFindings({
			consolidated: consolidated as never,
			input: inp,
			chunkOutput: () => chunk,
		});
	const cons = (findings: unknown[], extra: Record<string, unknown> = {}) =>
		parseConsolidated(JSON.stringify({ changed: "", strengths: [], opportunities: [], findings, ...extra }));

	test("falls back to the input then the chunk files when there is no consolidated file", () => {
		expect(resolve(null, input()).output.findings).toEqual([a, b]);
		expect(resolve(null, null).output).toBe(chunk);
	});

	test("a broken consolidated file warns once and uses the input", () => {
		const result = resolve({ error: "bad" }, input());
		expect(result.warnings).toHaveLength(1);
		expect(result.output.findings).toEqual([a, b]);
	});

	test("a consolidated file with no input warns once and uses the chunk files", () => {
		const result = resolve(cons([{ id: "c1-1", body: "x" }]), null);
		expect(result.warnings).toHaveLength(1);
		expect(result.output).toBe(chunk);
	});

	test("takes title, body and class from the consolidated file and tier, path and line from the input", () => {
		const result = resolve(cons([{ id: "c1-1", title: "New", body: "new body", class: "npe", otherPlaces: [] }]), input());
		const [first] = result.output.findings;
		expect(first).toMatchObject({ id: "c1-1", title: "New", body: "new body", class: "npe", tier: "high", path: "a.ts", line: 4, side: "new" });
	});

	test("ignores a consolidated tier, path and line, and does not require them", () => {
		const result = resolve(cons([{ id: "c1-1", body: "x", tier: "low", path: "z.ts", line: 9 }]), input());
		expect(result.output.findings[0]).toMatchObject({ tier: "high", path: "a.ts", line: 4 });
	});

	test("keeps the input title when the consolidated finding has none", () => {
		expect(resolve(cons([{ id: "c1-1", body: "x" }]), input()).output.findings[0].title).toBe("In A");
	});

	test("drops an unknown id with a warning that names it", () => {
		const result = resolve(cons([{ id: "c9-9", body: "x" }, { id: "c1-1", body: "y" }]), input());
		expect(result.output.findings.map((f) => f.id)).toEqual(["c1-1", "c1-2"]);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain("c9-9");
	});

	test("drops a finding with no id with one warning and adds the input finding back", () => {
		const result = resolve(cons([{ body: "x" }]), input());
		expect(result.warnings).toHaveLength(1);
		expect(result.output.findings).toEqual([a, b]);
	});

	test("an id only in the rejected list counts as unknown", () => {
		const rejected = { ...finding({ id: "c1-3", tier: "high" }), reason: "no" };
		const result = resolve(cons([{ id: "c1-3", body: "x" }]), input({ rejected: [rejected] }));
		expect(result.warnings[0]).toContain("c1-3");
		expect(result.output.findings.map((f) => f.id)).toEqual(["c1-1", "c1-2"]);
		expect(result.rejected).toEqual([rejected]);
	});

	test("a duplicate id keeps the first with one warning", () => {
		const result = resolve(cons([{ id: "c1-1", title: "First", body: "x" }, { id: "c1-1", title: "Second", body: "y" }]), input());
		expect(result.warnings).toHaveLength(1);
		expect(result.output.findings.filter((f) => f.id === "c1-1")).toHaveLength(1);
		expect(result.output.findings[0].title).toBe("First");
	});

	test("findings: [] adds every input finding back and an empty summary uses the input", () => {
		const result = resolve(cons([]), input());
		expect(result.output.findings).toEqual([a, b]);
		expect(result.output.changed).toBe("in changed");
		expect(result.output.strengths).toEqual(["in s"]);
		expect(result.output.opportunities).toEqual(["in o"]);
	});

	test("a consolidated summary wins when it is not empty", () => {
		const result = resolve(cons([], { changed: "new", strengths: ["s2"] }), input());
		expect(result.output).toMatchObject({ changed: "new", strengths: ["s2"], opportunities: ["in o"] });
	});

	test("a dropped finding is added back unchanged after the consolidated ones", () => {
		const result = resolve(cons([{ id: "c1-2", body: "x" }]), input());
		expect(result.output.findings.map((f) => f.id)).toEqual(["c1-2", "c1-1"]);
		expect(result.output.findings[1]).toBe(a);
	});

	test("groups an id by otherPlaces and the keeper takes the higher tier", () => {
		const keeper = finding({ id: "c1-1", tier: "medium", path: "k.ts", line: 1, class: "dup" });
		const other = finding({ id: "c2-1", tier: "high", path: "o.ts", line: 7, class: "dup" });
		const result = resolve(cons([{ id: "c1-1", body: "x", class: "dup", otherPlaces: ["o.ts:7"] }]), input({ findings: [keeper, other] }));
		expect(result.output.findings).toHaveLength(1);
		expect(result.output.findings[0]).toMatchObject({ id: "c1-1", tier: "high" });
	});

	test("groups a null-line finding by its path", () => {
		const keeper = finding({ id: "c1-1", path: "k.ts", line: 1 });
		const other = finding({ id: "c2-1", path: "o.ts", line: null });
		const result = resolve(cons([{ id: "c1-1", body: "x", class: "dup", otherPlaces: ["o.ts"] }]), input({ findings: [keeper, other] }));
		expect(result.output.findings.map((f) => f.id)).toEqual(["c1-1"]);
	});

	test("two ids at one place and one otherPlaces entry group one and add the other back", () => {
		const keeper = finding({ id: "c1-1", tier: "medium", path: "k.ts", line: 1, side: "new" });
		const same = finding({ id: "c2-1", tier: "medium", path: "o.ts", line: 7, side: "new" });
		const wrongSide = finding({ id: "c2-2", tier: "high", path: "o.ts", line: 7, side: "old" });
		const result = resolve(
			cons([{ id: "c1-1", body: "x", class: "dup", otherPlaces: ["o.ts:7"] }]),
			input({ findings: [keeper, wrongSide, same] }),
		);
		expect(result.output.findings.map((f) => f.id)).toEqual(["c1-1", "c2-2"]);
		expect(result.output.findings[0].tier).toBe("medium");
	});

	test("takes the first candidate at a place that passes the kind guard", () => {
		const keeper = finding({ id: "c1-1", path: "k.ts", line: 1, tier: "medium" });
		const improvement = finding({ id: "c2-1", path: "o.ts", line: 7, tier: "high", kind: "improvement" });
		const match = finding({ id: "c2-2", path: "o.ts", line: 7, tier: "low" });
		const result = resolve(
			cons([{ id: "c1-1", body: "x", class: "dup", otherPlaces: ["o.ts:7"] }]),
			input({ findings: [keeper, improvement, match] }),
		);
		expect(result.output.findings.map((f) => f.id)).toEqual(["c1-1", "c2-1"]);
		expect(result.output.findings[0].tier).toBe("medium");
		const matchFirst = resolve(
			cons([{ id: "c1-1", body: "x", class: "dup", otherPlaces: ["o.ts:7"] }]),
			input({ findings: [keeper, finding({ ...improvement, id: "c2-3" }), match] }),
		);
		expect(matchFirst.output.findings.map((f) => f.id)).toEqual(["c1-1", "c2-3"]);
	});

	test("the tie-break also requires the same class when the candidate has one", () => {
		const keeper = finding({ id: "c1-1", path: "k.ts", line: 1 });
		const otherClass = finding({ id: "c2-1", path: "o.ts", line: 7, class: "different" });
		const sameClass = finding({ id: "c2-2", path: "o.ts", line: 7, class: "Dup" });
		const result = resolve(
			cons([{ id: "c1-1", body: "x", class: "dup", otherPlaces: ["o.ts:7"] }]),
			input({ findings: [keeper, otherClass, sameClass] }),
		);
		expect(result.output.findings.map((f) => f.id)).toEqual(["c1-1", "c2-1"]);
	});

	test("one otherPlaces entry groups one id at most across keepers", () => {
		const k1 = finding({ id: "c1-1", path: "k.ts", line: 1 });
		const k2 = finding({ id: "c1-2", path: "k.ts", line: 2 });
		const other = finding({ id: "c2-1", path: "o.ts", line: 7 });
		const result = resolve(
			cons([
				{ id: "c1-1", body: "x", class: "dup", otherPlaces: ["o.ts:7"] },
				{ id: "c1-2", body: "y", class: "dup", otherPlaces: ["o.ts:7"] },
			]),
			input({ findings: [k1, k2, other] }),
		);
		expect(result.output.findings.map((f) => f.id)).toEqual(["c1-1", "c1-2"]);
	});

	test("does not group without a keeper class", () => {
		const keeper = finding({ id: "c1-1", path: "k.ts", line: 1 });
		const other = finding({ id: "c2-1", path: "o.ts", line: 7 });
		const result = resolve(cons([{ id: "c1-1", body: "x", otherPlaces: ["o.ts:7"] }]), input({ findings: [keeper, other] }));
		expect(result.output.findings.map((f) => f.id)).toEqual(["c1-1", "c2-1"]);
	});

	test("the guard adds back a critical finding when the keeper has a different preExisting value", () => {
		const keeper = finding({ id: "c1-1", tier: "medium", path: "k.ts", line: 1, preExisting: true });
		const critical = finding({ id: "c2-1", tier: "critical", path: "o.ts", line: 7 });
		const result = resolve(
			cons([{ id: "c1-1", body: "x", class: "dup", otherPlaces: ["o.ts:7"] }]),
			input({ findings: [keeper, critical] }),
		);
		expect(result.output.findings.map((f) => f.id)).toEqual(["c1-1", "c2-1"]);
		expect(result.output.findings[0].tier).toBe("medium");
		expect(result.output.findings[1]).toBe(critical);
	});

	test("the guard compares kind", () => {
		const keeper = finding({ id: "c1-1", path: "k.ts", line: 1 });
		const improvement = finding({ id: "c2-1", path: "o.ts", line: 7, kind: "improvement" });
		const result = resolve(
			cons([{ id: "c1-1", body: "x", class: "dup", otherPlaces: ["o.ts:7"] }]),
			input({ findings: [keeper, improvement] }),
		);
		expect(result.output.findings).toHaveLength(2);
	});

	test("counts unverified ids in the final set and not grouped ones", () => {
		const keeper = finding({ id: "c1-1", path: "k.ts", line: 1 });
		const grouped = finding({ id: "c2-1", path: "o.ts", line: 7 });
		const added = finding({ id: "c2-2", path: "p.ts", line: 3 });
		const result = resolve(
			cons([{ id: "c1-1", body: "x", class: "dup", otherPlaces: ["o.ts:7"] }]),
			input({ findings: [keeper, grouped, added], unverified: ["c1-1", "c2-1", "c2-2"] }),
		);
		expect(result.unverified).toBe(2);
	});

	test("counts unverified ids when compile uses the input alone", () => {
		expect(resolve(null, input({ unverified: ["c1-2"] })).unverified).toBe(1);
	});

	test("matchKeys hold the input title and class, never the consolidated text", () => {
		const result = resolve(cons([{ id: "c1-1", title: "New title", body: "x", class: "new class" }]), input());
		expect(result.matchKeys.get("c1-1")).toEqual({ title: "In A", class: "null-deref" });
		expect(result.matchKeys.get("c1-2")).toEqual({ title: "In B" });
	});

	test("passes the input rejected list through", () => {
		const rejected = { ...finding({ id: "c1-3" }), reason: "no" };
		expect(resolve(cons([]), input({ rejected: [rejected] })).rejected).toEqual([rejected]);
		expect(resolve(null, input({ rejected: [rejected] })).rejected).toEqual([rejected]);
	});
});


describe("thrash triage command", () => {
	const CLI = path.join(import.meta.dir, "../src/index.ts");
	const dirs: string[] = [];
	cliFixtures.isolateCliTests();
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	interface Setup {
		repo: string;
		scratch: string;
		diffPath: string;
		chunks: Array<{ findingsPath: string }>;
	}

	function run(setup: Pick<Setup, "repo" | "scratch">, args: string[]) {
		const proc = Bun.spawnSync([process.execPath, "run", CLI, "thrash", ...args], {
			cwd: setup.repo,
			env: { ...process.env, AI_SCRATCH_DIR: setup.scratch },
		});
		return { stdout: proc.stdout.toString(), stderr: proc.stderr.toString(), exitCode: proc.exitCode };
	}

	function setup(findings: unknown[] | null): Setup {
		const repo = makeTempDir("thrash-triage-repo-");
		const scratch = makeTempDir("thrash-triage-scratch-");
		dirs.push(repo, scratch);
		cliFixtures.runGit(["init", "-q"], repo);
		cliFixtures.runGit(["symbolic-ref", "HEAD", "refs/heads/main"], repo);
		cliFixtures.runGit(["config", "user.email", "t@t.t"], repo);
		cliFixtures.runGit(["config", "user.name", "T"], repo);
		mkdirSync(path.join(repo, "src"));
		const lines = (n: number) => Array.from({ length: n }, (_, i) => `export const v${i} = ${i};\n`).join("");
		cliFixtures.commitFile(repo, "src/a.ts", "export const base = 0;\n", "chore: base");
		cliFixtures.runGit(["checkout", "-q", "-b", "feature"], repo);
		writeFileSync(path.join(repo, "src/a.ts"), `export const base = 0;\n${lines(30)}`);
		const diff = run({ repo, scratch }, ["diff", ".", "--no-repo"]);
		expect(diff.exitCode, diff.stderr).toBe(EXIT.OK);
		const out = JSON.parse(diff.stdout) as { diffPath: string; chunks: Array<{ findingsPath: string }> };
		if (findings) {
			writeFileSync(
				out.chunks[0].findingsPath,
				JSON.stringify({ changed: "c", strengths: [], opportunities: [], findings }),
			);
		}
		return { repo, scratch, diffPath: out.diffPath, chunks: out.chunks };
	}

	const item = (line: number, tier: Tier, extra: Partial<Finding> = {}) => ({
		path: "src/a.ts",
		line,
		tier,
		title: `${tier} ${line}`,
		body: `${tier} body ${line}`,
		...extra,
	});

	function merge(s: Setup, spice = "3") {
		const result = run(s, ["triage", "--diff", s.diffPath, "--stage", "merge", "--spice", spice]);
		expect(result.exitCode, result.stderr).toBe(EXIT.OK);
		return JSON.parse(result.stdout) as {
			mergedPath: string;
			tasksPath: string;
			tasks: Array<{ id: string; taskPath: string; verdictPath: string }>;
			overCap: string[];
		};
	}

	function apply(s: Setup) {
		const result = run(s, ["triage", "--diff", s.diffPath, "--stage", "apply"]);
		expect(result.exitCode, result.stderr).toBe(EXIT.OK);
		return JSON.parse(result.stdout) as Record<string, unknown> & { consolidateInputPath: string; consolidatedPath: string };
	}

	const planOf = (s: Setup) => JSON.parse(readFileSync(s.diffPath.replace(/\.diff$/, ".plan.json"), "utf8"));

	test("merge writes the merged file, the tasks file and one task file per task with absolute paths", () => {
		const s = setup([item(2, "critical"), item(3, "high"), item(4, "nit")]);
		const out = merge(s);
		expect(out.tasks.map((t) => t.id)).toEqual(["c1-1", "c1-2"]);
		for (const task of out.tasks) {
			expect(path.isAbsolute(task.taskPath)).toBe(true);
			expect(path.isAbsolute(task.verdictPath)).toBe(true);
			const written = JSON.parse(readFileSync(task.taskPath, "utf8"));
			expect(written).toMatchObject({ id: task.id, verdictPath: task.verdictPath, bundleContextPath: null });
		}
		expect(out.overCap).toEqual([]);
		const tasksFile = JSON.parse(readFileSync(out.tasksPath, "utf8"));
		expect(tasksFile.tasks).toHaveLength(2);
		expect(JSON.parse(readFileSync(out.mergedPath, "utf8")).findings.map((f: Finding) => f.id)).toEqual([
			"c1-1",
			"c1-2",
			"c1-3",
		]);
	});

	test("16 counted medium findings and 1 pre-existing medium finding give 16 tasks and the pre-existing id in overCap", () => {
		const counted = Array.from({ length: 16 }, (_, i) => item(i + 2, "medium"));
		const s = setup([item(1, "medium", { preExisting: true }), ...counted]);
		const out = merge(s);
		expect(out.tasks).toHaveLength(16);
		expect(out.overCap).toEqual(["c1-1"]);
	});

	test("a second merge removes the verdict files and the task files of the first", () => {
		const s = setup([item(2, "high")]);
		const first = merge(s);
		writeFileSync(first.tasks[0].verdictPath, "{}");
		writeFileSync(`${first.tasks[0].verdictPath.replace(/verdict\..*$/, "verdicts.json")}`, "{}");
		writeFileSync(s.chunks[0].findingsPath, JSON.stringify({ changed: "c", strengths: [], opportunities: [], findings: [] }));
		const second = merge(s);
		expect(second.tasks).toEqual([]);
		expect(existsSync(first.tasks[0].verdictPath)).toBe(false);
		expect(existsSync(first.tasks[0].taskPath)).toBe(false);
		expect(existsSync(first.tasks[0].verdictPath.replace(/verdict\..*$/, "verdicts.json"))).toBe(false);
	});

	test("merge exits non-zero when a chunk findings file is missing", () => {
		const s = setup(null);
		const result = run(s, ["triage", "--diff", s.diffPath, "--stage", "merge"]);
		expect(result.exitCode).not.toBe(EXIT.OK);
		expect(result.stderr).toContain("has no findings file at");
	});

	test("merge with nothing in scope writes empty lists and apply then writes the consolidate input", () => {
		const s = setup([item(2, "nit")]);
		const out = merge(s);
		expect(out.tasks).toEqual([]);
		expect(JSON.parse(readFileSync(out.tasksPath, "utf8"))).toEqual({ tasks: [], overCap: [] });
		const applied = apply(s);
		const input = JSON.parse(readFileSync(applied.consolidateInputPath, "utf8"));
		expect(input).toMatchObject({ rejected: [], unverified: [] });
		expect(input.findings).toHaveLength(1);
		expect(applied).toMatchObject({ confirmed: 0, adjusted: 0, rejected: 0, unverified: 0 });
	});

	test("apply before merge exits non-zero and names the merged file", () => {
		const s = setup([item(2, "high")]);
		const result = run(s, ["triage", "--diff", s.diffPath, "--stage", "apply"]);
		expect(result.exitCode).not.toBe(EXIT.OK);
		expect(result.stderr).toContain(".merged.json");
	});

	test("apply removes an old consolidated file and sets consolidatedPath without touching the other plan keys", () => {
		const s = setup([item(2, "high")]);
		const before = planOf(s);
		const out = merge(s);
		writeFileSync(out.tasks[0].verdictPath, JSON.stringify({ id: "c1-1", verdict: "confirmed", reason: "ok" }));
		const consolidated = apply(s).consolidatedPath;
		writeFileSync(consolidated, "old");
		const applied = apply(s);
		expect(existsSync(applied.consolidatedPath)).toBe(false);
		const after = planOf(s);
		expect(after.consolidatedPath).toBe(path.basename(applied.consolidatedPath));
		const { consolidatedPath: _set, ...rest } = after;
		expect(rest).toEqual(before);
		expect(applied).toMatchObject({ confirmed: 1, unverified: 0 });
	});

	test("two apply runs write the same files", () => {
		const s = setup([item(2, "high"), item(3, "medium")]);
		const out = merge(s);
		writeFileSync(out.tasks[0].verdictPath, JSON.stringify({ id: "c1-1", verdict: "adjusted", reason: "r" }));
		const first = apply(s);
		const files = [first.consolidateInputPath, first.consolidateInputPath.replace(/consolidate\.input/, "verdicts")];
		const snapshot = files.map((file) => readFileSync(file, "utf8"));
		apply(s);
		expect(files.map((file) => readFileSync(file, "utf8"))).toEqual(snapshot);
		expect(first.unverified).toBe(2);
	});

	test("plan.json keeps the repo, bundle and contextPath values after apply", () => {
		const s = setup([item(2, "high")]);
		const plan = planOf(s);
		plan.repo = { root: "tree", headSha: "abc", source: "clone" };
		plan.chunks[0].bundle = { files: ["src/a.ts"], symbols: [], dependents: [], tests: [], related: [] };
		plan.chunks[0].contextPath = "slug.chunk1.bundle.md";
		writeFileSync(s.diffPath.replace(/\.diff$/, ".plan.json"), JSON.stringify(plan, null, 2));
		merge(s);
		apply(s);
		const after = planOf(s);
		expect(after.repo).toEqual(plan.repo);
		expect(after.chunks[0].bundle).toEqual(plan.chunks[0].bundle);
		expect(after.chunks[0].contextPath).toBe(plan.chunks[0].contextPath);
	});

	test("a failed merge leaves the earlier triage files in place", () => {
		const s = setup([item(2, "high")]);
		const first = merge(s);
		rmSync(s.chunks[0].findingsPath);
		const result = run(s, ["triage", "--diff", s.diffPath, "--stage", "merge"]);
		expect(result.exitCode).not.toBe(EXIT.OK);
		expect(existsSync(first.mergedPath)).toBe(true);
		expect(existsSync(first.tasksPath)).toBe(true);
		expect(existsSync(first.tasks[0].taskPath)).toBe(true);
	});

	function compile(s: Setup) {
		return run(s, ["compile", ".", "--diff", s.diffPath, "--json"]);
	}

	function reviewText(stdout: string): string {
		return JSON.stringify(JSON.parse(readFileSync(JSON.parse(stdout).reviewPath, "utf8")).review);
	}

	test("compile falls back to the chunk files with one warning when the consolidate input is corrupt", () => {
		const s = setup([item(2, "high", { title: "From chunk" })]);
		merge(s);
		apply(s);
		const inputPath = triagePaths(s.diffPath).consolidateInput;
		for (const bad of ["{not json", JSON.stringify({ findings: [{ path: "src/a.ts", line: 2, body: "x", tier: "bogus" }] })]) {
			writeFileSync(inputPath, bad);
			const result = compile(s);
			expect(result.exitCode, result.stderr).toBe(EXIT.OK);
			expect(result.stderr.match(/consolidate input does not parse/g)).toHaveLength(1);
			expect(reviewText(result.stdout)).toContain("high body 2");
		}
	});

	test("compile ignores a reviewer id on the chunk file path", () => {
		const s = setup([item(2, "high", { id: "c9-9" })]);
		const result = compile(s);
		expect(result.exitCode, result.stderr).toBe(EXIT.OK);
		expect(result.stderr).toBe("");
		const text = reviewText(result.stdout);
		expect(text).toContain("high body 2");
		expect(text).not.toContain("c9-9");
	});
});
