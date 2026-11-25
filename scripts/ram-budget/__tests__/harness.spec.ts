import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "..", "..", "ram-budget.ts");
let dir = "";
let fakeDg = "";

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "ram-budget-spec-"));
	fakeDg = join(dir, "dg");
	writeFileSync(fakeDg, "#!/bin/sh\nsleep 0.2\necho 1.0.0\n");
	chmodSync(fakeDg, 0o755);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function harness(msBudget: number, extra: string[] = []) {
	const budgets = join(dir, `budgets-${msBudget}.json`);
	writeFileSync(budgets, JSON.stringify({ version: 1, cases: { version: { peakMB: 64, msBudget } } }));
	const out = join(dir, `out-${msBudget}.json`);
	const run = Bun.spawnSync(
		["bun", SCRIPT, "--dg", fakeDg, "--budgets", budgets, "--only", "version", "--latency-runs", "5", "--json", out, ...extra],
		{ stdout: "pipe", stderr: "pipe" },
	);
	return { code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString(), out };
}

describe.skipIf(process.platform === "win32")("ram-budget latency cases", () => {
	test("a case over msBudget prints SLOW and fails --gate on linux", () => {
		const run = harness(50, ["--gate"]);
		expect(run.stdout).toContain("50 SLOW");
		expect(run.code).toBe(process.platform === "linux" ? 1 : 0);
	});

	test("a case inside msBudget passes --gate and reports peak, ms, p90 and p95", () => {
		const run = harness(5000, ["--gate"]);
		expect(run.stdout).not.toContain("SLOW");
		expect(run.code).toBe(0);
		const { results } = JSON.parse(readFileSync(run.out, "utf8")) as { results: Record<string, Record<string, number>> };
		expect(results.version).toMatchObject({ budget: 64, msBudget: 5000 });
		for (const key of ["peak", "ms", "p90", "p95"]) expect(results.version?.[key]).toBeGreaterThan(0);
		expect(results.version?.ms).toBeGreaterThanOrEqual(150);
	});

	test("without --gate a slow case is reported and the run still exits 0", () => {
		const run = harness(50);
		expect(run.stdout).toContain("50 SLOW");
		expect(run.code).toBe(0);
	});

	test("a case with no budget stops the run before it measures", () => {
		const budgets = join(dir, "empty.json");
		writeFileSync(budgets, JSON.stringify({ version: 1, cases: {} }));
		const run = Bun.spawnSync(["bun", SCRIPT, "--dg", fakeDg, "--budgets", budgets, "--only", "version"], { stdout: "pipe", stderr: "pipe" });
		expect(run.exitCode).toBe(2);
		expect(run.stderr.toString()).toContain('case "version" has no budget in');
	});
});
