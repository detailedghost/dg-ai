import { afterEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { isUnder } from "../../../skills-cli/__tests__/path-under";
import {
	allocatePort,
	bootServe,
	cleanupDgHome,
	freshDgHome,
	removeScratchDirs,
	subprocessEnv,
} from "./daemon-harness";

afterEach(removeScratchDirs);

describe("daemon harness under the test fence", () => {
	it("gives a subprocess no XDG_CONFIG_HOME and a HOME below the temp dir", () => {
		const env = subprocessEnv(freshDgHome(), allocatePort());

		expect(env.XDG_CONFIG_HOME).toBeUndefined();
		expect(isUnder(tmpdir(), env.HOME)).toBe(true);
	});

	it("passes the DG_PATH_FENCE of the parent to a subprocess", () => {
		const env = subprocessEnv(freshDgHome(), allocatePort());

		expect(process.env.DG_PATH_FENCE).toBeTruthy();
		expect(env.DG_PATH_FENCE).toBe(process.env.DG_PATH_FENCE);
	});

	it("boots a daemon in a fresh DG_HOME with the inherited DG_PATH_FENCE", async () => {
		const boot = await bootServe();
		try {
			expect(isUnder(tmpdir(), boot.dgHome)).toBe(true);
			expect(boot.proc.exitCode).toBeNull();
		} finally {
			boot.proc.kill();
			await boot.proc.exited;
			cleanupDgHome(boot.dgHome);
		}
	});
});
