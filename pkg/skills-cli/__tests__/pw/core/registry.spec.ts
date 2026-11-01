import { describe, expect, test } from "bun:test";
import { existsSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cwdHash } from "@dg/common/node";
import {
	defaultOutputDir,
	isAlive,
	isDaemonOf,
	isLive,
	list,
	read,
	reapStale,
	recordPath,
	remove,
	resolve,
	type SessionRecord,
	sessionKey,
	signalDaemon,
	socketPathFor,
	stopSession,
	touch,
	write,
} from "../../../src/pw/core/registry";
import {
	spawnFakeDaemonProcess,
	startFakeDaemon,
	useFakeDaemons,
	useTempScratch,
} from "../../../src/pw/test-support";

const scratch = useTempScratch();
const daemons = useFakeDaemons();

function record(
	key: string,
	overrides: Partial<SessionRecord> = {},
): SessionRecord {
	return {
		name: key.split("@")[0] as string,
		key,
		pid: daemons.pidFor(key),
		socketPath: socketPathFor(key),
		cwd: "/work",
		outputDir: "/tmp/out",
		mode: "local",
		browser: "chrome",
		headless: true,
		scratch: key.includes("@"),
		codegen: false,
		profileDir: null,
		startedAt: "2026-10-07T00:00:00.000Z",
		...overrides,
	};
}

describe("sessionKey", () => {
	test("keys a persistent session to its name", () => {
		expect(sessionKey({ name: "default", scratch: false })).toBe("default");
	});

	test("keys a scratch session to name@cwdHash", () => {
		expect(sessionKey({ name: "default", scratch: true })).toBe(
			`default@${cwdHash()}`,
		);
	});
});

describe("registry files", () => {
	test("writes a 0600 record and reads it back", () => {
		const written = record("alpha");
		write(written);
		expect(read("alpha")?.pid).toBe(written.pid);
		expect(statSync(recordPath("alpha")).mode & 0o777).toBe(0o600);
	});

	test("treats a corrupt record as absent and deletes it", () => {
		write(record("alpha"));
		writeFileSync(recordPath("alpha"), "{not json");
		expect(read("alpha")).toBeNull();
		expect(existsSync(recordPath("alpha"))).toBe(false);
	});

	test("remove deletes the record and any socket file", () => {
		write(record("alpha"));
		writeFileSync(socketPathFor("alpha"), "");
		remove("alpha");
		expect(read("alpha")).toBeNull();
		expect(existsSync(socketPathFor("alpha"))).toBe(false);
	});

	test("touch moves the record mtime forward", () => {
		write(record("alpha"));
		const old = new Date(Date.now() - 86_400_000);
		utimesSync(recordPath("alpha"), old, old);
		touch("alpha");
		expect(statSync(recordPath("alpha")).mtimeMs).toBeGreaterThan(
			old.getTime() + 60_000,
		);
	});

	test("touch ignores a missing record", () => {
		expect(() => touch("ghost")).not.toThrow();
	});
});

describe("list", () => {
	test("removes an entry whose pid is dead", () => {
		write(record("alive"));
		write(record("dead", { pid: 2_147_483_646 }));
		writeFileSync(socketPathFor("dead"), "");
		expect(list().map((r) => r.key)).toEqual(["alive"]);
		expect(existsSync(recordPath("dead"))).toBe(false);
		expect(existsSync(socketPathFor("dead"))).toBe(false);
	});

	test("returns records sorted by key", () => {
		write(record("zulu"));
		write(record("alpha"));
		expect(list().map((r) => r.key)).toEqual(["alpha", "zulu"]);
	});
});

describe("resolve", () => {
	test("prefers the scratch session of this directory over the persistent one", () => {
		const scratchKey = sessionKey({ name: "web", scratch: true });
		write(record("web"));
		write(record(scratchKey));
		expect(resolve("web")?.key).toBe(scratchKey);
	});

	test("falls back to the persistent session", () => {
		write(record("web"));
		expect(resolve("web")?.key).toBe("web");
	});

	test("drops a dead record and returns null", () => {
		write(record("web", { pid: 2_147_483_646 }));
		expect(resolve("web")).toBeNull();
		expect(existsSync(recordPath("web"))).toBe(false);
	});
});

describe("isAlive", () => {
	test("is true for this process and false for an unused pid", () => {
		expect(isAlive(process.pid)).toBe(true);
		expect(isAlive(2_147_483_646)).toBe(false);
	});
});

describe("defaultOutputDir", () => {
	test("creates the per-directory output folder as 0700", () => {
		const dir = defaultOutputDir();
		expect(dir.startsWith(path.join(scratch.dir, "pw"))).toBe(true);
		expect(statSync(dir).mode & 0o777).toBe(0o700);
	});
});

describe("isDaemonOf without /proc", () => {
	test("falls back to liveness when the command line is unreadable", () => {
		expect(isDaemonOf({ pid: process.pid, key: "gh" }, null)).toBe(true);
		expect(isDaemonOf({ pid: 2147483646, key: "gh" }, null)).toBe(false);
	});
});

describe("isDaemonOf", () => {
	const argv = (key: string, entry = "/opt/dg/dg.js") => [
		"/h/.bun/bin/bun",
		entry,
		"dg-skills",
		"pw",
		"__daemon",
		JSON.stringify({ name: "x", key }),
	];

	test("accepts the bundled, source and compiled daemon of the same key", () => {
		expect(isDaemonOf({ pid: 1, key: "gh" }, argv("gh"))).toBe(true);
		const source = [
			"/h/.bun/bin/bun",
			"/r/pkg/skills-cli/src/index.ts",
			"pw",
			"__daemon",
			'{"key":"gh"}',
		];
		expect(isDaemonOf({ pid: 1, key: "gh" }, source)).toBe(true);
		expect(
			isDaemonOf({ pid: 1, key: "gh" }, [
				"/h/.dg/bin/dg-skills",
				"pw",
				"__daemon",
				'{"key":"gh"}',
			]),
		).toBe(true);
	});

	test("rejects a daemon that serves another key", () => {
		expect(isDaemonOf({ pid: 1, key: "gh" }, argv("work"))).toBe(false);
	});

	test("rejects an unrelated process that reused the pid", () => {
		expect(
			isDaemonOf({ pid: 1, key: "gh" }, ["/usr/bin/vim", "notes.md"]),
		).toBe(false);
		expect(
			isDaemonOf({ pid: 1, key: "gh" }, [
				"/bin/zsh",
				"-c",
				"pgrep -f dg-skills pw __daemon gh",
			]),
		).toBe(false);
	});

	test("rejects a daemon whose last argument is not the launch spec", () => {
		expect(
			isDaemonOf({ pid: 1, key: "gh" }, [
				"/h/.bun/bin/bun",
				"/opt/dg/dg.js",
				"dg-skills",
				"pw",
				"__daemon",
				"gh",
			]),
		).toBe(false);
	});

	test("rejects a missing process", () => {
		expect(isDaemonOf({ pid: 2_147_483_646, key: "gh" })).toBe(false);
	});

	test("falls back to liveness when the command line is unreadable", () => {
		expect(isDaemonOf({ pid: process.pid, key: "gh" }, null)).toBe(true);
		expect(isDaemonOf({ pid: 2_147_483_646, key: "gh" }, null)).toBe(false);
	});
});

describe("stale records for a reused pid", () => {
	test("list and resolve drop a record whose pid now runs another program", () => {
		write(record("web", { pid: process.pid }));
		expect(list()).toEqual([]);
		expect(existsSync(recordPath("web"))).toBe(false);
		write(record("web", { pid: process.pid }));
		expect(resolve("web")).toBeNull();
		expect(existsSync(recordPath("web"))).toBe(false);
	});

	test("signalDaemon never signals a process that is not the recorded daemon", async () => {
		const bystander = Bun.spawn(["sleep", "30"]);
		try {
			signalDaemon(record("web", { pid: bystander.pid }), "SIGKILL");
			await Bun.sleep(50);
			expect(bystander.killed).toBe(false);
			expect(isAlive(bystander.pid)).toBe(true);
		} finally {
			bystander.kill();
		}
	});

	test("signalDaemon signals the matching daemon", async () => {
		const child = spawnFakeDaemonProcess("web");
		signalDaemon(record("web", { pid: child.pid }), "SIGKILL");
		await child.exited;
		expect(child.signalCode).toBe("SIGKILL");
	});

	test("isLive is false for a live pid that is not the daemon", () => {
		expect(isLive(record("web", { pid: process.pid }))).toBe(false);
		expect(isLive(record("web"))).toBe(true);
	});
});

const windowsRecord = (
	key: string,
	overrides: Partial<SessionRecord> = {},
): SessionRecord =>
	record(key, {
		mode: "cdp",
		winPid: 4242,
		profileDir: `C:\\p\\${key}`,
		cdpUrl: "http://127.0.0.1:20001",
		...overrides,
	});

describe("reapStale", () => {
	test("closes the Windows browser of a record whose daemon died, then drops the record", async () => {
		write(windowsRecord("gh", { pid: 2_147_483_646 }));
		const closed: string[] = [];
		await reapStale(async (profileDir) => void closed.push(profileDir));
		expect(closed).toEqual(["C:\\p\\gh"]);
		expect(existsSync(recordPath("gh"))).toBe(false);
	});

	test("keeps the record for a retry when the Windows browser does not close", async () => {
		write(windowsRecord("gh", { pid: 2_147_483_646 }));
		await reapStale(async () => {
			throw new Error("close failed");
		});
		expect(existsSync(recordPath("gh"))).toBe(true);
	});

	test("keeps the record when Windows browser processes survive the close", async () => {
		write(windowsRecord("gh", { pid: 2_147_483_646 }));
		await reapStale(async () => ({ forced: 0, remaining: 1 }));
		expect(existsSync(recordPath("gh"))).toBe(true);
	});

	test("keeps the list-time cleanup from deleting the record before reaping", async () => {
		write(windowsRecord("gh", { pid: 2_147_483_646 }));
		expect(list()).toEqual([]);
		expect(existsSync(recordPath("gh"))).toBe(true);
	});

	test("does not close a browser that a live session shares through the same profile", async () => {
		write(
			windowsRecord("gh", { pid: 2_147_483_646, profileDir: "C:\\p\\shared" }),
		);
		write(windowsRecord("other", { profileDir: "C:\\p\\shared" }));
		const closed: string[] = [];
		await reapStale(async (profileDir) => void closed.push(profileDir));
		expect(closed).toEqual([]);
		expect(existsSync(recordPath("gh"))).toBe(false);
		expect(existsSync(recordPath("other"))).toBe(true);
	});

	test("never closes a browser for a session that only attached", async () => {
		write(
			record("remote", {
				pid: 2_147_483_646,
				mode: "cdp",
				cdpUrl: "http://127.0.0.1:9222",
			}),
		);
		const closed: string[] = [];
		await reapStale(async (profileDir) => void closed.push(profileDir));
		expect(closed).toEqual([]);
		expect(existsSync(recordPath("remote"))).toBe(false);
	});
});

describe("stopSession force path", () => {
	test("closes the Windows browser after it had to signal a daemon that ignored stop", async () => {
		const daemon = await startFakeDaemon(
			"gh",
			{ mode: "cdp", winPid: 1, profileDir: "C:\\p\\gh" },
			() => ({
				text: "",
				exitCode: 0,
			}),
		);
		const closed: string[] = [];
		try {
			await stopSession(
				{
					...daemon.record,
					socketPath: path.join(scratch.dir, "missing.sock"),
				},
				{
					graceMs: 50,
					termMs: 500,
					closeBrowser: async (profileDir) => void closed.push(profileDir),
				},
			);
			await daemon.child.exited;
			expect(closed).toEqual(["C:\\p\\gh"]);
		} finally {
			daemon.dispose();
		}
	});

	test("keeps the record and reports failure when the forced Windows close leaves processes", async () => {
		const daemon = await startFakeDaemon(
			"gh",
			{ mode: "cdp", winPid: 1, profileDir: "C:\\p\\gh" },
			undefined,
			{ keepRecordOnStop: true },
		);
		try {
			const closed = await stopSession(
				{
					...daemon.record,
					socketPath: path.join(scratch.dir, "missing.sock"),
				},
				{
					graceMs: 50,
					termMs: 500,
					closeBrowser: async () => ({ forced: 1, remaining: 2 }),
				},
			);
			await daemon.child.exited;
			expect(closed).toBe(false);
			expect(existsSync(recordPath("gh"))).toBe(true);
		} finally {
			daemon.dispose();
		}
	});

	test("keeps the record and reports failure when the forced Windows close throws", async () => {
		const daemon = await startFakeDaemon(
			"gh",
			{ mode: "cdp", winPid: 1, profileDir: "C:\\p\\gh" },
			undefined,
			{ keepRecordOnStop: true },
		);
		try {
			const closed = await stopSession(
				{
					...daemon.record,
					socketPath: path.join(scratch.dir, "missing.sock"),
				},
				{
					graceMs: 50,
					termMs: 500,
					closeBrowser: async () => {
						throw new Error("powershell failed");
					},
				},
			);
			await daemon.child.exited;
			expect(closed).toBe(false);
			expect(existsSync(recordPath("gh"))).toBe(true);
		} finally {
			daemon.dispose();
		}
	});

	test("reports failure and keeps the record when the daemon could not close its browser", async () => {
		const daemon = await startFakeDaemon(
			"gh",
			{ mode: "cdp", winPid: 1, profileDir: "C:\\p\\gh" },
			undefined,
			{ keepRecordOnStop: true },
		);
		try {
			const closed = await stopSession(daemon.record, {
				closeBrowser: async () => ({ forced: 0, remaining: 0 }),
			});
			expect(closed).toBe(false);
			expect(existsSync(recordPath("gh"))).toBe(true);
		} finally {
			daemon.dispose();
		}
	});

	test("reports success and drops the record when the daemon closed cleanly", async () => {
		const daemon = await startFakeDaemon("gh", {
			mode: "cdp",
			winPid: 1,
			profileDir: "C:\\p\\gh",
		});
		try {
			expect(await stopSession(daemon.record)).toBe(true);
			expect(existsSync(recordPath("gh"))).toBe(false);
		} finally {
			daemon.dispose();
		}
	});

	test("skips the Windows close when the daemon exits on its own", async () => {
		const daemon = await startFakeDaemon("gh", {
			mode: "cdp",
			winPid: 1,
			profileDir: "C:\\p\\gh",
		});
		const closed: string[] = [];
		try {
			await stopSession(daemon.record, {
				closeBrowser: async (profileDir) => void closed.push(profileDir),
			});
			expect(closed).toEqual([]);
		} finally {
			daemon.dispose();
		}
	});
});
