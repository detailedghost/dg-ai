import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessIdentity } from "@dg/common/node/process-identity";
import { daemonIdentity, isDaemonServeArgs, isOurDaemon } from "../src/legacy-daemon-identity";

const WRITTEN_MS = 1_800_000_000_000;
const found = (args: string[], startMs: number): ProcessIdentity => ({ kind: "found", args, startMs });

describe("isDaemonServeArgs", () => {
	test.each([
		[["/usr/bin/bun", "/home/u/.dg/lib/current/dg.js", "dg-daemon", "__serve"]],
		[["/usr/bin/bun", "/repo/pkg/dg-daemon/src/index.ts", "__serve"]],
		[["/home/u/bin/dg-daemon", "__serve"]],
		[["C:\\dg\\dg-daemon.exe", "__serve"]],
		[["/usr/bin/bun", "/home/u/.dg/lib/current/dg.js", "dg-daemon", "serve"]],
		[["/home/u/bin/dg-daemon", "serve"]],
	])("accepts %j", (args) => {
		expect(isDaemonServeArgs(args)).toBe(true);
	});

	test.each([
		[["sleep", "300"]],
		[["/usr/bin/bun", "/repo/pkg/dg-daemon/src/index.ts", "status"]],
		[["/usr/bin/node", "server.js", "__serve"]],
		[["/usr/bin/vim", "notes-dg-daemon.txt", "__serve"]],
		[["/usr/bin/node", "server.js", "serve"]],
	])("rejects %j", (args) => {
		expect(isDaemonServeArgs(args)).toBe(false);
	});
});

describe("daemonIdentity", () => {
	const serve = ["bun", "dg.js", "dg-daemon", "__serve"];

	test("is ours when the start is before the pid file write", () => {
		expect(daemonIdentity(found(serve, WRITTEN_MS - 5000), WRITTEN_MS)).toBe("ours");
	});

	test("is ours when the start is within the slack after the pid file write", () => {
		expect(daemonIdentity(found(serve, WRITTEN_MS + 1500), WRITTEN_MS)).toBe("ours");
	});

	test("is foreign when the process started well after the pid file write", () => {
		expect(daemonIdentity(found(serve, WRITTEN_MS + 60_000), WRITTEN_MS)).toBe("foreign");
	});

	test("is foreign for a command line that is not a daemon serve", () => {
		expect(daemonIdentity(found(["sleep", "300"], WRITTEN_MS - 5000), WRITTEN_MS)).toBe("foreign");
	});

	test("is foreign for a dead process and unknown when the lookup fails", () => {
		expect(daemonIdentity({ kind: "dead" }, WRITTEN_MS)).toBe("foreign");
		expect(daemonIdentity({ kind: "unknown" }, WRITTEN_MS)).toBe("unknown");
	});

	test("is unknown when the pid file time is unreadable", () => {
		expect(daemonIdentity(found(serve, WRITTEN_MS), undefined)).toBe("unknown");
	});
});

describe("isOurDaemon", () => {
	test("is foreign for the test's own child, which is not a daemon serve", async () => {
		const dir = mkdtempSync(join(tmpdir(), "dg-daemon-identity-"));
		const child = Bun.spawn(["sleep", "300"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
		try {
			const pidFile = join(dir, "daemon.pid");
			writeFileSync(pidFile, "{}");
			utimesSync(pidFile, new Date(), new Date());
			expect(isOurDaemon(child.pid, pidFile)).toBe("foreign");
		} finally {
			child.kill("SIGKILL");
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
