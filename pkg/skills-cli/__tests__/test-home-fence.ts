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
for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) delete process.env[key];

afterAll(() => {
	runTestRunEndTasks();
	rmSync(fence, { recursive: true, force: true });
});
