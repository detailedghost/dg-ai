import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { budgetScale, buildBundle, median, run } from "./bundle-fixtures";

setDefaultTimeout(120_000);

const OVERHEAD_BUDGET_MS = 20;
const RUNS = 7;
const PROGRAMS = ["dg-skills", "dg-agent", "dg-daemon"];

function warmMedian(bun: string, entry: string, args: string[]): number {
	const spawn = () => run(bun, entry, args);
	expect(spawn().exitCode).toBe(0);
	const times: number[] = [];
	for (let i = 0; i < RUNS; i++) {
		const result = spawn();
		expect(result.exitCode).toBe(0);
		times.push(result.ms);
	}
	return median(times);
}

describe("startup budget", () => {
	const { bun, entry } = buildBundle();
	const scratch = mkdtempSync(join(tmpdir(), "dg-floor-"));
	const emptyEntry = join(scratch, "empty.js");
	writeFileSync(emptyEntry, "");

	afterAll(() => rmSync(scratch, { recursive: true, force: true }));

	for (const program of PROGRAMS) {
		test(`${program} --version adds under ${OVERHEAD_BUDGET_MS} ms to an empty bun process (median of ${RUNS} warm runs)`, () => {
			const floor = warmMedian(bun, emptyEntry, []);
			const ms = warmMedian(bun, entry, [program, "--version"]);
			console.log(JSON.stringify({ program, floor, ms, over: ms - floor }));
			expect(ms - floor).toBeLessThan(OVERHEAD_BUDGET_MS * budgetScale());
		});
	}
});
