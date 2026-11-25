#!/usr/bin/env bun
/** Peak RSS and p50 latency of the native dg front door per case, checked against native/budgets. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

type FrontCase = { name: string; args: string[]; expect: RegExp; stdin?: string };
type Measurement = { peakRssBytes?: number; p50Ms: number };
type Budget = Record<string, Partial<Measurement>>;

const ROOT = resolve(import.meta.dir, "..");
const PLACEHOLDER_OUTPUT = "dg";
const MARKER = "dg-measure";
const HELPER_SOURCE = `#include <stdio.h>
#include <time.h>
#include <unistd.h>
#include <sys/wait.h>
#include <sys/resource.h>
int main(int argc, char **argv) {
	struct timespec start, end;
	struct rusage usage;
	int status;
	clock_gettime(CLOCK_MONOTONIC, &start);
	pid_t pid = fork();
	if (pid == 0) {
		execv(argv[1], argv + 1);
		_exit(127);
	}
	wait4(pid, &status, 0, &usage);
	clock_gettime(CLOCK_MONOTONIC, &end);
	long long ns = (end.tv_sec - start.tv_sec) * 1000000000LL + (end.tv_nsec - start.tv_nsec);
	fprintf(stderr, "\\n${MARKER} %d %ld %lld\\n", WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status), usage.ru_maxrss, ns);
	return 0;
}
`;

const HOOK_PR_CREATE = JSON.stringify({
	hook_event_name: "PreToolUse",
	tool_name: "Bash",
	tool_input: { command: "gh pr create --fill" },
	cwd: ".",
});

export const CASES: FrontCase[] = [
	{ name: "version", args: ["--version"], expect: /\S/ },
	{ name: "completion", args: ["__complete", "stat", "ch"], expect: /\S/ },
	{ name: "hooks", args: ["hooks", "run", "pr-confirm"], expect: /"permissionDecision":"ask"/, stdin: HOOK_PR_CREATE },
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

const RSS_UNIT_BYTES = process.platform === "darwin" ? 1 : 1024;

export function buildHelper(dir: string): string | undefined {
	if (process.platform === "win32") return undefined;
	const source = join(dir, "measure.c");
	const helper = join(dir, "measure");
	writeFileSync(source, HELPER_SOURCE);
	const built = spawnSync("cc", ["-O1", "-o", helper, source], { encoding: "utf8" });
	if (built.status !== 0) throw new Error(`cc could not build the RSS helper: ${built.stderr || built.error}`);
	return helper;
}

async function run(
	bin: string,
	c: FrontCase,
	root: string,
	env: Record<string, string>,
	helper: string | undefined,
) {
	const started = performance.now();
	const child = Bun.spawn(helper ? [helper, bin, ...c.args] : [bin, ...c.args], {
		cwd: root,
		env,
		stdin: c.stdin === undefined ? "ignore" : new Blob([c.stdin]),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exited] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	const wall = performance.now() - started;
	if (!helper) return { code: exited, stdout, ms: wall, peak: undefined };
	const reported = new RegExp(`^${MARKER} (\\d+) (\\d+) (\\d+)$`, "m").exec(stderr);
	if (!reported) throw new Error(`the RSS helper reported nothing for ${c.name}: ${stderr}`);
	return {
		code: Number(reported[1]),
		stdout,
		ms: Number(reported[3]) / 1e6,
		peak: Number(reported[2]) * RSS_UNIT_BYTES,
	};
}

export async function measureCase(
	bin: string,
	c: FrontCase,
	runs: number,
	root: string,
	env: Record<string, string>,
	helper?: string,
): Promise<Measurement | undefined> {
	const probe = await run(bin, c, root, env, helper);
	if (probe.code !== 0 || probe.stdout.trim() === PLACEHOLDER_OUTPUT || !c.expect.test(probe.stdout))
		return undefined;
	const samples = [probe];
	for (let i = 1; i < runs; i++) samples.push(await run(bin, c, root, env, helper));
	const peaks = samples.flatMap((s) => (s.peak === undefined ? [] : [s.peak]));
	return {
		...(peaks.length > 0 ? { peakRssBytes: median(peaks) } : {}),
		p50Ms: Math.round(median(samples.map((s) => s.ms)) * 100) / 100,
	};
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
	let unsupported = 0;
	try {
		const env = fencedEnv(root);
		const helper = buildHelper(root);
		for (const c of CASES) {
			const result = await measureCase(bin, c, runs, root, env, helper);
			if (!result) {
				console.error(`FAIL ${c.name}: the probe exited non-zero or printed unexpected output`);
				unsupported++;
				continue;
			}
			measured[c.name] = result;
			console.log(`${c.name}: peak RSS ${result.peakRssBytes ?? "not measured"} B, p50 ${result.p50Ms} ms`);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}

	if (values.json) writeFileSync(values.json, `${JSON.stringify(measured, null, "\t")}\n`);

	const failures = overBudget(measured, budget);
	for (const f of failures) console.error(`${gating ? "FAIL" : "report"} ${f}`);
	if (values.gate && !gating) console.log(`report only on ${process.platform}; the gate runs on linux`);
	process.exit(unsupported > 0 || (gating && failures.length > 0) ? 1 : 0);
}
