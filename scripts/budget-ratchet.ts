import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export type Flat = Record<string, number>;
export type Increase = { budget: string; old: number; next: number; reason: string };
export type Lowered = { budget: string; old: number; next: number };
export type RatchetResult = {
	failures: string[];
	warnings: string[];
	lowered: Lowered[];
};
export type Row = {
	budget: string;
	base: number | null;
	budgetValue: number;
	measured: number | null;
};

const DEFAULT_SLACK_PCT = 5;
const COMMENT_MARKER = "<!-- budget-ratchet -->";
const BUDGET_FILES = [
	"scripts/ram-budgets.json",
	"scripts/lean-budgets.json",
	"scripts/skill-token-budgets.json",
];
const BUDGET_DIRS = ["native/budgets", "native/bench/Dg.Bench/budgets"];
const INCREASE_LINE =
	/^Budget-Increase:[ \t]+(\S+)[ \t]+(-?\d+(?:\.\d+)?)[ \t]+->[ \t]+(-?\d+(?:\.\d+)?)[ \t]+because[ \t]+(\S.*?)[ \t]*$/;
const REMOVAL_LINE = /^Budget-Removal:[ \t]+(\S+)[ \t]+because[ \t]+\S.*$/;

export function flatten(prefix: string, value: unknown, path = ""): Flat {
	if (typeof value === "number") return { [`${prefix}:${path}`]: value };
	if (value === null || typeof value !== "object") return {};
	const out: Flat = {};
	for (const [key, child] of Object.entries(value))
		Object.assign(out, flatten(prefix, child, path ? `${path}/${key}` : key));
	return out;
}

export function parseIncreases(prBody: string): Increase[] {
	const out: Increase[] = [];
	for (const raw of prBody.split(/\r?\n/)) {
		const m = INCREASE_LINE.exec(raw);
		if (m)
			out.push({ budget: m[1], old: Number(m[2]), next: Number(m[3]), reason: m[4] });
	}
	return out;
}

export function parseRemovals(prBody: string): string[] {
	const out: string[] = [];
	for (const raw of prBody.split(/\r?\n/)) {
		const m = REMOVAL_LINE.exec(raw.trimEnd());
		if (m) out.push(m[1]);
	}
	return out;
}

function floorSignificant(value: number): number {
	if (value >= 100) return Math.floor(value);
	const scale = 10 ** (2 - Math.floor(Math.log10(value)));
	return Math.floor(value * scale) / scale;
}

/** True for a latency or memory-growth budget, which gates overruns only. */
function isCeiling(name: string): boolean {
	const last = name.slice(name.lastIndexOf("/") + 1);
	return /latency/i.test(name) || /^(ms|p\d+)$/i.test(last) || /ms(budget)?$/i.test(last) || /^growthMB$/i.test(last);
}

export function ratchet(input: {
	budgets: Flat;
	measured: Flat;
	prBody: string;
	slackPct?: number;
	baseBudgets?: Flat;
}): RatchetResult {
	const slackPct = input.slackPct ?? DEFAULT_SLACK_PCT;
	const increases = parseIncreases(input.prBody);
	const removals = parseRemovals(input.prBody);
	const failures: string[] = [];
	const warnings: string[] = [];
	const lowered: Lowered[] = [];

	for (const [budget, limit] of Object.entries(input.budgets)) {
		const base = input.baseBudgets?.[budget];
		if (base !== undefined && limit < base) lowered.push({ budget, old: base, next: limit });
		if (base !== undefined && limit > base) {
			const ok = increases.some(
				(i) => i.budget === budget && i.old === base && i.next === limit,
			);
			if (!ok)
				failures.push(
					`${budget}: budget raised ${base} -> ${limit} without a matching "Budget-Increase: ${budget} ${base} -> ${limit} because <reason>" line in the PR body`,
				);
		}

		const value = input.measured[budget];
		if (value === undefined) {
			warnings.push(`${budget}: no measurement, skipped`);
			continue;
		}
		if (value > limit) {
			failures.push(
				`${budget}: measured ${value} is over the budget ${limit}; fix the regression or raise the budget with a Budget-Increase line`,
			);
			continue;
		}
		if (isCeiling(budget)) continue;
		if (value > 0 && (limit - value) * 100 > slackPct * value)
			failures.push(
				`${budget}: measured ${value} leaves more than ${slackPct}% slack under the budget ${limit}; lower the budget to ${floorSignificant(value * (1 + slackPct / 100))}`,
			);
	}

	for (const budget of Object.keys(input.baseBudgets ?? {}))
		if (!(budget in input.budgets) && !removals.includes(budget))
			failures.push(
				`${budget}: budget removed without a matching "Budget-Removal: ${budget} because <reason>" line in the PR body`,
			);

	for (const i of increases)
		if (!(i.budget in input.budgets))
			warnings.push(`${i.budget}: Budget-Increase line names an unknown budget`);

	return { failures, warnings, lowered };
}

export function discoverBudgetFiles(root: string): string[] {
	const found = BUDGET_FILES.filter((p) => existsSync(join(root, p)));
	for (const dir of BUDGET_DIRS) {
		const abs = join(root, dir);
		if (!existsSync(abs)) continue;
		for (const name of readdirSync(abs).sort())
			if (name.endsWith(".json")) found.push(`${dir}/${name}`);
	}
	return found;
}

function prefixOf(path: string): string {
	return basename(path, ".json");
}

export function run(input: {
	root: string;
	measuredDir: string;
	prBody: string;
	readBase: (path: string) => string | null;
}): RatchetResult & { rows: Row[] } {
	const budgets: Flat = {};
	const baseBudgets: Flat = {};
	const measured: Flat = {};
	const paths = new Set([...BUDGET_FILES, ...discoverBudgetFiles(input.root)]);
	for (const path of paths) {
		const prefix = prefixOf(path);
		if (existsSync(join(input.root, path)))
			Object.assign(
				budgets,
				flatten(prefix, JSON.parse(readFileSync(join(input.root, path), "utf8"))),
			);
		const base = input.readBase(path);
		if (base !== null) Object.assign(baseBudgets, flatten(prefix, JSON.parse(base)));
		const measuredPath = join(input.measuredDir, basename(path));
		if (existsSync(measuredPath))
			Object.assign(measured, flatten(prefix, JSON.parse(readFileSync(measuredPath, "utf8"))));
	}
	const result = ratchet({ budgets, baseBudgets, measured, prBody: input.prBody });
	const rows = Object.entries(budgets).map(([budget, budgetValue]) => ({
		budget,
		base: baseBudgets[budget] ?? null,
		budgetValue,
		measured: measured[budget] ?? null,
	}));
	return { ...result, rows };
}

export function renderComment(
	result: RatchetResult & { rows: Row[] },
	growth: string,
): string {
	const status = result.failures.length === 0 ? "passing" : "failing";
	const lines = [COMMENT_MARKER, `### Budget ratchet: ${status}`, ""];
	if (result.failures.length > 0) {
		lines.push(...result.failures.map((f) => `- FAIL ${f}`), "");
	}
	if (result.warnings.length > 0) {
		lines.push(...result.warnings.map((w) => `- warn ${w}`), "");
	}
	lines.push("| Budget | Base | Budget now | Measured |", "| --- | ---: | ---: | ---: |");
	for (const r of result.rows)
		lines.push(`| ${r.budget} | ${r.base ?? "new"} | ${r.budgetValue} | ${r.measured ?? "none"} |`);
	if (growth.trim() !== "") lines.push("", "#### Module growth", "", "```", growth.trim(), "```");
	return `${lines.join("\n")}\n`;
}

function readBaseFrom(root: string, ref: string): (path: string) => string | null {
	return (path) => {
		const r = spawnSync("git", ["show", `${ref}:${path}`], { cwd: root, encoding: "utf8" });
		return r.status === 0 ? r.stdout : null;
	};
}

function flag(name: string): string | undefined {
	const i = process.argv.indexOf(name);
	return i === -1 ? undefined : process.argv[i + 1];
}

if (import.meta.main) {
	const root = process.cwd();
	const baseRef = flag("--base-ref") ?? process.env.BASE_SHA;
	const growthPath = flag("--growth");
	const result = run({
		root,
		measuredDir: flag("--measured") ?? "budget-measurements",
		prBody: process.env.PR_BODY ?? "",
		readBase: baseRef ? readBaseFrom(root, baseRef) : () => null,
	});
	const growth =
		growthPath && existsSync(growthPath) ? readFileSync(growthPath, "utf8") : "";
	const comment = renderComment(result, growth);
	const commentPath = flag("--comment");
	if (commentPath) writeFileSync(commentPath, comment);
	console.log(comment);
	process.exit(result.failures.length === 0 ? 0 : 1);
}
