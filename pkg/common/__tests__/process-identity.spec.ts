import { describe, expect, test } from "bun:test";
import {
	parseProcCmdline,
	parsePsCommand,
	parsePsStart,
	procStartMs,
	readProcessIdentity,
} from "../src/node/process-identity";

const STAT = "1234 (dg daemon) S 1 1234 1234 0 -1 4194560 100 0 0 0 5 2 0 0 20 0 8 0 150000 1000000 500 18446744073709551615";
const PROC_STAT = "cpu  1 2 3\nbtime 1800000000\nprocesses 99\n";

describe("process identity parsing", () => {
	test("splits a cmdline on NUL and drops the empty tail", () => {
		expect(parseProcCmdline("bun\0dg.js\0dg-daemon\0__serve\0")).toEqual(["bun", "dg.js", "dg-daemon", "__serve"]);
	});

	test("splits a ps command on whitespace", () => {
		expect(parsePsCommand("  /usr/bin/bun dg.js dg-daemon __serve\n")).toEqual([
			"/usr/bin/bun",
			"dg.js",
			"dg-daemon",
			"__serve",
		]);
	});

	test("adds the stat start ticks to the boot time, even when the command name holds spaces and parens", () => {
		expect(procStartMs(STAT, PROC_STAT)).toBe(1_800_000_000_000 + 1_500_000);
		expect(procStartMs(STAT.replace("(dg daemon)", "(a) b (c)"), PROC_STAT)).toBe(1_800_000_000_000 + 1_500_000);
	});

	test("returns undefined for a stat without a start time or a proc stat without btime", () => {
		expect(procStartMs("garbage", PROC_STAT)).toBeUndefined();
		expect(procStartMs(STAT, "cpu 1 2 3\n")).toBeUndefined();
	});

	test("parses a ps lstart line and rejects junk", () => {
		expect(parsePsStart("Thu Nov  6 10:00:00 2026\n")).toBe(new Date(2026, 10, 6, 10, 0, 0).getTime());
		expect(parsePsStart("not a date")).toBeUndefined();
	});
});

describe("readProcessIdentity", () => {
	test("reads the command line and a plausible start time of the test's own child", async () => {
		const child = Bun.spawn(["sleep", "300"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
		try {
			let identity = readProcessIdentity(child.pid);
			for (let tries = 0; identity.kind !== "found" && tries < 100; tries++) {
				await Bun.sleep(20);
				identity = readProcessIdentity(child.pid);
			}
			expect(identity.kind).toBe("found");
			if (identity.kind !== "found") return;
			expect(identity.args).toEqual(["sleep", "300"]);
			expect(Math.abs(Date.now() - identity.startMs)).toBeLessThan(60_000);
		} finally {
			child.kill("SIGKILL");
			await child.exited;
		}
	});

	test("is dead for an exited child and unknown for an invalid pid or an unsupported platform", async () => {
		const child = Bun.spawn(["true"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
		await child.exited;
		expect(readProcessIdentity(child.pid)).toEqual({ kind: "dead" });
		expect(readProcessIdentity(0)).toEqual({ kind: "unknown" });
		expect(readProcessIdentity(process.pid, "win32")).toEqual({ kind: "unknown" });
	});
});
