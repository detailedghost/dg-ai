import { describe, expect, it } from "bun:test";
import { runArgv } from "../src/node/process";

describe("runArgv", () => {
	it("captures the code, stdout and stderr of a command", async () => {
		const result = await runArgv([process.execPath, "-e", "console.log('out');console.error('err');process.exit(3)"]);

		expect(result).toEqual({ code: 3, stdout: "out\n", stderr: "err\n" });
	});

	it("gives code 1, empty stdout and the error text for a command that cannot spawn", async () => {
		const result = await runArgv(["/dg-test/no/such/command"]);

		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).not.toBe("");
	});

	it("passes the env it is given to the command", async () => {
		const result = await runArgv([process.execPath, "-e", "console.log(process.env.DG_RUN_ARGV_PROBE)"], {
			...process.env,
			DG_RUN_ARGV_PROBE: "probe",
		});

		expect(result.stdout).toBe("probe\n");
	});
});
