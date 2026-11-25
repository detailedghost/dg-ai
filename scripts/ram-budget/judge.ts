export const MB = 1024 * 1024;

export type CaseBudget = { peakMB: number; msBudget?: number; growthMB?: number };
export type Budgets = { version: 1; cases: Record<string, CaseBudget> };
export type Sample = { peak: number; ms: number; idle?: number; anon?: number; growth?: number; p90?: number; p95?: number };
export type Verdict = { over: boolean; slow: boolean; leaking: boolean };

const BUDGET_KEYS = ["peakMB", "msBudget", "growthMB"];

function positive(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function parseBudgets(text: string, source: string): Budgets {
	const data = JSON.parse(text) as { version?: unknown; cases?: Record<string, Record<string, unknown>> };
	if (data.version !== 1) throw new Error(`${source}: version must be 1`);
	const cases: Record<string, CaseBudget> = {};
	for (const [name, entry] of Object.entries(data.cases ?? {})) {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry))
			throw new Error(`${source}: case "${name}" must be an object`);
		for (const key of Object.keys(entry))
			if (!BUDGET_KEYS.includes(key)) throw new Error(`${source}: case "${name}" has unknown key "${key}"`);
		for (const key of BUDGET_KEYS) {
			const value = entry[key];
			if (value === undefined && key !== "peakMB") continue;
			if (!positive(value)) throw new Error(`${source}: case "${name}" ${key} must be a positive number`);
		}
		cases[name] = entry as CaseBudget;
	}
	return { version: 1, cases };
}

export function budgetMismatch(allNames: string[], budgets: Budgets, selected: string[] = allNames): string[] {
	const missing = selected.filter((name) => !(name in budgets.cases)).map((name) => `case "${name}" has no budget in ram-budgets.json`);
	const stale = Object.keys(budgets.cases).filter((name) => !allNames.includes(name)).map((name) => `budget "${name}" has no case`);
	return [...missing, ...stale];
}

export function judge(sample: Sample, budget: CaseBudget, ungated: boolean): Verdict {
	return {
		over: !ungated && sample.peak > budget.peakMB * MB,
		slow: budget.msBudget !== undefined && sample.ms > budget.msBudget,
		leaking: budget.growthMB !== undefined && (sample.growth ?? 0) > budget.growthMB * MB,
	};
}

export function quantile(sorted: number[], fraction: number): number {
	const value = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
	if (value === undefined) throw new Error("no samples to take a quantile of");
	return value;
}

export function summarize(samples: Sample[]): Sample {
	const peaks = samples.map((sample) => sample.peak).sort((x, y) => x - y);
	const times = samples.map((sample) => sample.ms).sort((x, y) => x - y);
	return { peak: quantile(peaks, 0.5), ms: quantile(times, 0.5), p90: quantile(times, 0.9), p95: quantile(times, 0.95) };
}

export function gateExit(platform: string, gate: boolean, failed: number): number {
	return gate && platform === "linux" && failed > 0 ? 1 : 0;
}
