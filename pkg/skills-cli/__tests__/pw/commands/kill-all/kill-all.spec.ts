import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { killRegistered } from "../../../../src/pw/commands/kill-all/run";
import spec from "../../../../src/pw/commands/kill-all/spec";
import {
	DAEMON_PATTERN,
	list,
	read,
	recordPath,
	type SessionRecord,
	socketPathFor,
	write,
} from "../../../../src/pw/core/registry";
import {
	argsFor,
	startFakeDaemon,
	useTempScratch,
} from "../../../../src/pw/test-support";

useTempScratch();

describe("kill-all spec", () => {
	test("takes no arguments", () => {
		expect(argsFor(spec).positionals).toEqual([]);
	});
});

describe("DAEMON_PATTERN", () => {
	const matches = (cmdline: string) => new RegExp(DAEMON_PATTERN).test(cmdline);

	test("matches the bundled, source and compiled daemon command lines", () => {
		expect(
			matches(
				'/home/me/.bun/bin/bun /opt/dg/dg.js dg-skills pw __daemon {"name":"x"}',
			),
		).toBe(true);
		expect(
			matches(
				'/home/me/.bun/bin/bun /repo/pkg/skills-cli/src/index.ts pw __daemon {"name":"x"}',
			),
		).toBe(true);
		expect(matches('/home/me/.dg/bin/dg-skills pw __daemon {"name":"x"}')).toBe(
			true,
		);
	});

	test("does not match a shell or tool whose command text merely mentions the daemon", () => {
		expect(matches("/bin/zsh -c pgrep -f dg-skills pw __daemon")).toBe(false);
		expect(matches("grep pw __daemon notes.md")).toBe(false);
		expect(matches("/usr/bin/vim /home/me/dg.js")).toBe(false);
		expect(matches("/home/me/.dg/bin/dg-skills pw list")).toBe(false);
		expect(matches("/usr/bin/rg dg.js dg-skills pw __daemon  src")).toBe(false);
		expect(
			matches("/usr/bin/rg skills-cli/src/index.ts pw __daemon  src"),
		).toBe(false);
		expect(matches("rg bun /opt/dg/dg.js dg-skills pw __daemon  src")).toBe(
			false,
		);
		expect(
			matches(
				"/usr/bin/notbun /repo/pkg/skills-cli/src/index.ts pw __daemon {}",
			),
		).toBe(false);
	});

	test("matches a bare bun on PATH and bun run", () => {
		expect(
			matches('bun /opt/dg/dg.js dg-skills pw __daemon {"name":"x"}'),
		).toBe(true);
		expect(
			matches(
				'/usr/local/bin/bun run /repo/pkg/skills-cli/src/index.ts pw __daemon {"name":"x"}',
			),
		).toBe(true);
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
		const daemon = await startFakeDaemon("win", {
			mode: "cdp",
			winPid: 77,
			profileDir: "C:\\p\\win",
		});
		const order: string[] = [];
		try {
			await killRegistered(list(), async (profileDir) => {
				order.push(
					`close ${profileDir} alive=${daemon.child.exitCode === null}`,
				);
			});
			await daemon.child.exited;
			expect(order).toEqual(["close C:\\p\\win alive=true"]);
			expect(daemon.child.signalCode).toBe("SIGKILL");
		} finally {
			daemon.dispose();
		}
	});

	test("leaves the browser of an attached session alone", async () => {
		const daemon = await startFakeDaemon("remote", {
			mode: "cdp",
			cdpUrl: "http://127.0.0.1:9222",
		});
		const closed: string[] = [];
		try {
			await killRegistered(
				list(),
				async (profileDir) => void closed.push(profileDir),
			);
			expect(closed).toEqual([]);
		} finally {
			daemon.dispose();
		}
	});

	test("still kills the daemon when closing the Windows browser fails", async () => {
		const daemon = await startFakeDaemon("win", {
			mode: "cdp",
			winPid: 77,
			profileDir: "C:\\p\\win",
		});
		try {
			const failed = await killRegistered(list(), async () => {
				throw new Error("powershell failed");
			});
			await daemon.child.exited;
			expect(daemon.child.signalCode).toBe("SIGKILL");
			expect(failed).toEqual(["C:\\p\\win"]);
			expect(read("win")).not.toBeNull();
		} finally {
			daemon.dispose();
		}
	});

	test("keeps the record when Windows browser processes survive the close", async () => {
		const daemon = await startFakeDaemon("win", {
			mode: "cdp",
			winPid: 77,
			profileDir: "C:\\p\\win",
		});
		try {
			const failed = await killRegistered(list(), async () => ({
				forced: 1,
				remaining: 2,
			}));
			await daemon.child.exited;
			expect(failed).toEqual(["C:\\p\\win"]);
			expect(read("win")).not.toBeNull();
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
