#!/usr/bin/env bun
/** Peak RSS and p50 latency of the native dg front door per case, checked against native/budgets. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

type FrontCase = { name: string; args: string[]; stdin?: string };
type Measurement = { peakRssBytes: number; p50Ms: number };
type Budget = Record<string, Partial<Measurement>>;

const ROOT = resolve(import.meta.dir, "..");
const PLACEHOLDER_OUTPUT = "dg";

const HOOK_EDIT = JSON.stringify({
	hook_event_name: "PostToolUse",
	tool_name: "Edit",
	tool_input: { file_path: "notes.md", old_string: "a", new_string: "the color of the center" },
	tool_response: { success: true },
});

export const CASES: FrontCase[] = [
	{ name: "version", args: ["--version"] },
	{ name: "completion", args: ["__complete", "stat", "ch"] },
	{ name: "hooks", args: ["hooks", "run", "spelling"], stdin: HOOK_EDIT },
];

export function defaultRid(platform = process.platform, arch = process.arch): string {
	const os = platform === "win32" ? "win" : platform === "darwin" ? "osx" : "linux";
	return `${os}-${arch === "arm64" ? "arm64" : "x64"}`;
}

export function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor((sorted.length - 1) / 2)];
}

export function overBudget(measured: Record<string, Measurement>, budget: Budget): string[] {
	const failures: string[] = [];
	for (const [name, limits] of Object.entries(budget)) {
		const got = measured[name];
		if (!got) continue;
		for (const key of ["peakRssBytes", "p50Ms"] as const) {
			const limit = limits[key];
			if (limit !== undefined && got[key] > limit)
				failures.push(`${name}/${key}: measured ${got[key]} is over the budget ${limit}`);
		}
	}
	return failures;
}

function fencedEnv(root: string): Record<string, string> {
	const home = join(root, "home");
	mkdirSync(home, { recursive: true });
	const keep = ["PATH", "LANG", "TERM", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR"];
	const base = Object.fromEntries(
		keep.flatMap((name) => (process.env[name] ? [[name, process.env[name] as string]] : [])),
	);
	return {
		...base,
		HOME: home,
		USERPROFILE: home,
		DG_HOME: join(root, "dg"),
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_DATA_HOME: join(home, ".local", "share"),
		XDG_STATE_HOME: join(home, ".local", "state"),
		XDG_CACHE_HOME: join(home, ".cache"),
		AI_SCRATCH_DIR: join(root, "scratch"),
		AI_STATE_DIR: join(root, "state"),
		DG_PATH_FENCE: root,
		DG_KEY_SOURCE: "file",
		DG_FRONT: "1",
		NO_COLOR: "1",
	};
}

async function run(bin: string, c: FrontCase, root: string, env: Record<string, string>) {
	const started = performance.now();
	const child = Bun.spawn([bin, ...c.args], {
		cwd: root,
		env,
		stdin: c.stdin === undefined ? "ignore" : new Blob([c.stdin]),
		stdout: "pipe",
		stderr: "ignore",
	});
	const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
	return {
		code,
		stdout,
		ms: performance.now() - started,
		peak: child.resourceUsage()?.maxRSS ?? 0,
	};
}

export async function measureCase(
	bin: string,
	c: FrontCase,
	runs: number,
	root: string,
	env: Record<string, string>,
): Promise<Measurement | undefined> {
	const probe = await run(bin, c, root, env);
	if (probe.code !== 0 || [PLACEHOLDER_OUTPUT, ""].includes(probe.stdout.trim())) return undefined;
	const peaks = [probe.peak];
	const times = [probe.ms];
	for (let i = 1; i < runs; i++) {
		const sample = await run(bin, c, root, env);
		peaks.push(sample.peak);
		times.push(sample.ms);
	}
	return { peakRssBytes: median(peaks), p50Ms: Math.round(median(times) * 100) / 100 };
}

function usageError(detail: string): never {
	console.error(
		`${detail}\nusage: bun scripts/native-ram-budget.ts --dg <native dg> [--rid <rid>] [--budgets <file>] [--runs n] [--gate] [--json <file>]`,
	);
	process.exit(2);
}

if (import.meta.main) {
	const { values } = parseArgs({
		args: Bun.argv.slice(2),
		options: {
			dg: { type: "string" },
			rid: { type: "string", default: defaultRid() },
			budgets: { type: "string" },
			runs: { type: "string", default: "20" },
			gate: { type: "boolean", default: false },
			json: { type: "string" },
		},
	});
	if (!values.dg) usageError("--dg is required");
	const runs = Number(values.runs);
	if (!Number.isInteger(runs) || runs < 1) usageError(`--runs must be a whole number of 1 or more, got "${values.runs}"`);
	const bin = resolve(values.dg);
	if (!existsSync(bin)) usageError(`${bin} does not exist`);

	const budgetPath = values.budgets ?? join(ROOT, "native", "budgets", `native-ram-${values.rid}.json`);
	const budget: Budget = existsSync(budgetPath) ? JSON.parse(readFileSync(budgetPath, "utf8")) : {};
	const gating = values.gate && process.platform === "linux";

	const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "native-ram-"));
	const measured: Record<string, Measurement> = {};
	try {
		const env = fencedEnv(root);
		for (const c of CASES) {
			const result = await measureCase(bin, c, runs, root, env);
			if (!result) {
				console.log(`skip ${c.name}: the binary does not support it yet`);
				continue;
			}
			measured[c.name] = result;
			console.log(`${c.name}: peak RSS ${result.peakRssBytes} B, p50 ${result.p50Ms} ms`);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}

	if (values.json) writeFileSync(values.json, `${JSON.stringify(measured, null, "\t")}\n`);

	const failures = overBudget(measured, budget);
	for (const f of failures) console.error(`${gating ? "FAIL" : "report"} ${f}`);
	if (values.gate && !gating) console.log(`report only on ${process.platform}; the gate runs on linux`);
	process.exit(gating && failures.length > 0 ? 1 : 0);
}
