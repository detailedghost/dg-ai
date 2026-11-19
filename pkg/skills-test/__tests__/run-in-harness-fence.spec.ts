import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isUnder } from "../../skills-cli/__tests__/path-under";
import { REPO_ROOT, runInHarness } from "./test-support";

const DG_PATHS = join(REPO_ROOT, "pkg", "common", "src", "node", "dg-paths.ts");

const PRINT_ROOTS = `
import { resolveDgPaths } from ${JSON.stringify(DG_PATHS)};
const p = resolveDgPaths();
console.log(JSON.stringify([p.binDir, p.configDir, p.dataDir, p.stateDir, p.cacheDir, p.logDir, p.legacyHome]));
`;

const RESOLVE_ONLY = `
import { resolveDgPaths } from ${JSON.stringify(DG_PATHS)};
resolveDgPaths();
console.log("resolved");
`;

describe("runInHarness under the test fence", () => {
	it("resolves each DG root below the temp dir in a child with no env override", async () => {
		const result = await runInHarness(PRINT_ROOTS, {});

		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		const roots = JSON.parse(result.stdout.trim()) as string[];
		expect(roots).toHaveLength(7);
		for (const root of roots) expect(isUnder(tmpdir(), root)).toBe(true);
	});

	it("stops a child whose DG_HOME is outside the inherited fence", async () => {
		const outside = join(dirname(tmpdir()), "dg-outside-fence");

		const result = await runInHarness(RESOLVE_ONLY, { DG_HOME: outside });

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("dg path fence:");
		expect(result.stderr).toContain(outside);
	});
});
