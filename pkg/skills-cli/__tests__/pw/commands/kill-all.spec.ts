import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import {
	DAEMON_PATTERN,
	list,
	read,
	recordPath,
	type SessionRecord,
	socketPathFor,
	write,
} from "../../../src/pw/core/registry";
import { argsFor, startFakeDaemon, useTempScratch } from "../../../src/pw/test-support";
import { killRegistered } from "../../../src/pw/commands/kill-all/run";
import spec from "../../../src/pw/commands/kill-all/spec";

useTempScratch();

describe("kill-all spec", () => {
	test("takes no arguments", () => {
		expect(argsFor(spec).positionals).toEqual([]);
	});
});

describe("DAEMON_PATTERN", () => {
	const matches = (cmdline: string) => new RegExp(DAEMON_PATTERN).test(cmdline);

	test("matches a compiled and a source-mode self-reexec ending in the launch spec", () => {
		expect(matches('/h/.dg/bin/dg-skills pw __daemon {"name":"x"}')).toBe(true);
		expect(matches('/h/.bun/bin/bun /h/code/dg-ai/pkg/skills-cli/src/index.ts pw __daemon {"name":"x"}')).toBe(true);
	});

	test("does not match an unrelated dg-skills subcommand, even one that mentions pw __daemon in prose", () => {
		expect(matches("/h/.dg/bin/dg-skills bg drain x")).toBe(false);
		expect(matches("/h/.dg/bin/dg-skills phone-friend --line x __run")).toBe(false);
		expect(matches("/h/.dg/bin/dg-skills thrash --message please run pw __daemon now")).toBe(false);
	});

	test("does not match a shell or tool whose command text merely mentions the verb", () => {
		expect(matches("/bin/zsh -c pgrep -f pw __daemon")).toBe(false);
		expect(matches("grep pw __daemon notes.md")).toBe(false);
	});
});

describe("killRegistered", () => {
	test("kills every registered pid and clears records and sockets", async () => {
		const a = await startFakeDaemon("alpha");
		const b = await startFakeDaemon("beta");
		writeFileSync(socketPathFor("orphan"), "");
		try {
			await killRegistered(list());
			await Promise.all([a.child.exited, b.child.exited]);
			expect(a.child.signalCode).toBe("SIGKILL");
			expect(b.child.signalCode).toBe("SIGKILL");
			expect(existsSync(recordPath("alpha"))).toBe(false);
			expect(existsSync(socketPathFor("beta"))).toBe(false);
			expect(existsSync(socketPathFor("orphan"))).toBe(false);
		} finally {
			a.dispose();
			b.dispose();
		}
	});
});

describe("killRegistered and Windows browsers", () => {
	test("closes the Windows browser of a cdp session before it kills the daemon", async () => {
		const daemon = await startFakeDaemon("win", { mode: "cdp", winPid: 77, profileDir: "C:\\p\\win" });
		const order: string[] = [];
		try {
			await killRegistered(list(), async (profileDir) => {
				order.push(`close ${profileDir} alive=${daemon.child.exitCode === null}`);
			});
			await daemon.child.exited;
			expect(order).toEqual(["close C:\\p\\win alive=true"]);
			expect(daemon.child.signalCode).toBe("SIGKILL");
		} finally {
			daemon.dispose();
		}
	});

	test("leaves the browser of an attached session alone", async () => {
		const daemon = await startFakeDaemon("remote", { mode: "cdp", cdpUrl: "http://127.0.0.1:9222" });
		const closed: string[] = [];
		try {
			await killRegistered(list(), async (profileDir) => void closed.push(profileDir));
			expect(closed).toEqual([]);
		} finally {
			daemon.dispose();
		}
	});

	test("still kills the daemon when closing the Windows browser fails", async () => {
		const daemon = await startFakeDaemon("win", { mode: "cdp", winPid: 77, profileDir: "C:\\p\\win" });
		try {
			await killRegistered(list(), async () => {
				throw new Error("powershell failed");
			});
			await daemon.child.exited;
			expect(daemon.child.signalCode).toBe("SIGKILL");
		} finally {
			daemon.dispose();
		}
	});

	test("does not signal a pid that no longer runs the recorded daemon", async () => {
		const bystander = Bun.spawn(["sleep", "30"]);
		const daemon = await startFakeDaemon("ghost");
		try {
			write({ ...daemon.record, pid: bystander.pid });
			await killRegistered([read("ghost") as SessionRecord]);
			await Bun.sleep(50);
			expect(bystander.exitCode).toBeNull();
			expect(existsSync(recordPath("ghost"))).toBe(false);
		} finally {
			bystander.kill();
			daemon.dispose();
		}
	});
});
