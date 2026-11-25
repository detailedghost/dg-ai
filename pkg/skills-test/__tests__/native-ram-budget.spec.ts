import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { median, overBudget } from "../../../scripts/native-ram-budget";
import { quantile } from "../../../scripts/ram-budget/judge";
import { makeTempDir, removeTempDirs, REPO_ROOT } from "./test-support";

const SCRIPT = join(REPO_ROOT, "scripts", "native-ram-budget.ts");

afterEach(removeTempDirs);

describe("native ram budget", () => {
	test("takes the same p50 as the ram-budget judge for even counts", () => {
		const values = [40, 10, 30, 20];
		expect(median(values)).toBe(quantile([10, 20, 30, 40], 0.5));
	});

	test("reports a measured case that has no budget entry", () => {
		const failures = overBudget({ version: { p50Ms: 1 }, extra: { p50Ms: 1 } }, { version: { p50Ms: 5 } });
		expect(failures).toHaveLength(1);
		expect(failures[0]).toContain("extra");
		expect(failures[0]).toContain("no budget");
	});

	test("exits with a usage error when the budget file is missing", () => {
		const dir = makeTempDir("native-ram-");
		mkdirSync(dir, { recursive: true });
		const fake = join(dir, "dg");
		writeFileSync(fake, "#!/bin/sh\necho 1\n", { mode: 0o755 });
		const proc = Bun.spawnSync(["bun", SCRIPT, "--dg", fake, "--rid", "no-such-rid", "--gate", "--runs", "1"], {
			env: { ...process.env, NO_COLOR: "1" },
		});
		expect(proc.exitCode).toBe(process.platform === "linux" ? 2 : 0);
		if (process.platform !== "linux") return;
		expect(proc.stderr.toString()).toContain("native-ram-no-such-rid.json");
	});
});
