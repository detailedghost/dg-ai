import { describe, expect, test } from "bun:test";
import { main, RUN_CODE_MOVED } from "../../src/pw/cli";
import type { DaemonRequest } from "../../src/pw/core/socket";
import { clientEnv, startFakeDaemon, useTempScratch } from "../../src/pw/test-support";

useTempScratch();

describe("pw run-code", () => {
	test.each([
		[["run-code", "async (page) => 1"]],
		[["-s=web", "run-code", "--filename=x.js"]],
		[["--raw", "run-code", "--help"]],
	])("is refused with a pointer to pw-code for %p", async (argv) => {
		const env = clientEnv();
		expect(await main(argv, env)).toBe(2);
		expect(env.stderr).toEqual([RUN_CODE_MOVED]);
		expect(env.stdout).toEqual([]);
	});

	test("never reaches the daemon", async () => {
		const seen: DaemonRequest[] = [];
		const daemon = await startFakeDaemon("web", {}, (request) => {
			seen.push(request);
			return { text: "ran", exitCode: 0 };
		});
		try {
			await main(["-s=web", "run-code", "async (page) => 1"], clientEnv());
			expect(seen).toEqual([]);
		} finally {
			daemon.dispose();
		}
	});

	test("does not list run-code in the command index", async () => {
		const env = clientEnv();
		await main(["--help"], env);
		expect(env.stdout.join("\n")).not.toContain("run-code");
	});

	test("still forwards the other browser commands with the run method", async () => {
		const seen: DaemonRequest[] = [];
		const daemon = await startFakeDaemon("web", {}, (request) => {
			seen.push(request);
			return { text: "### Page", exitCode: 0 };
		});
		try {
			const env = clientEnv("/w");
			expect(await main(["-s=web", "reload"], env)).toBe(0);
			expect(seen[0]).toMatchObject({
				method: "run",
				params: { argv: ["--session=web", "reload"], cwd: "/w" },
			});
		} finally {
			daemon.dispose();
		}
	});
});
