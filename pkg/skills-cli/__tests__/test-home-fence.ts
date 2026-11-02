import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTestRunEndTasks } from "./test-run-end";

const fence = mkdtempSync(join(tmpdir(), "dg-test-home-"));

process.env.DG_WINDOWS_HOME = fence;
process.env.HOME = fence;
process.env.DG_HOME = join(fence, ".dg");
process.env.USERPROFILE = fence;

afterAll(() => {
	runTestRunEndTasks();
	rmSync(fence, { recursive: true, force: true });
});
