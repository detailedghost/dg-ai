import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDgPaths } from "@dg/common/node";
import { phoneOpen, type OpenCloseDeps } from "../../src/phone/commands";
import { PhoneDb } from "../../src/phone/db";
import {
	CRON_JITTER_SECONDS,
	CRON_MARKER,
	type CrontabIO,
	ensureCronLine,
	ensureListener,
	ensureLockPath,
	type EnsureDeps,
	installCrontabLine,
	mergeCrontab,
	openEnsureArgv,
	readRecordedPid,
	shQuote,
} from "../../src/phone/ensure";
import type { KeyClient } from "../../src/phone/keys";
import { listenerPidPath, spawnDetachedListener } from "../../src/phone/listener";
import { makeHomeTracker, parseNdjson } from "./fake-pool";

const tracker = makeHomeTracker("dg-phone-ensure-");
const homes: string[] = [];

function tempHome(): string {
	const dir = mkdtempSync(join(tmpdir(), "dg-phone-ensure-"));
	homes.push(dir);
	return dir;
}

function writeRaw(path: string, text: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text);
}

function deps(dir: string, overrides: Partial<EnsureDeps> = {}): EnsureDeps {
	return {
		paths: resolveDgPaths({ env: { DG_HOME: dir } }),
		now: () => 1_700_000_000,
		sleep: async () => {},
		isAlive: () => false,
		verdict: () => "foreign",
		argv: ["/fake/dg-agent", "phone", "__run"],
		hook: null,
		spawnListener: () => 4242,
		...overrides,
	};
}

afterEach(() => {
	tracker.cleanup();
	for (const dir of homes) rmSync(dir, { recursive: true, force: true });
	homes.length = 0;
});

describe("ensureListener", () => {
	it("replaces a stale pidfile and does not signal that pid", async () => {
		const dir = tempHome();
		const phone = deps(dir);
		writeRaw(listenerPidPath(phone.paths), JSON.stringify({ pid: 999_999_999, since: 1, hook: null }));
		const spawned: number[] = [];
		phone.spawnListener = () => {
			spawned.push(1);
			return 6100;
		};

		const result = await ensureListener(phone);

		expect(result).toEqual({ pid: 6100, status: "started" });
		expect(spawned).toEqual([1]);
		expect(JSON.parse(readFileSync(listenerPidPath(phone.paths), "utf8")).pid).toBe(6100);
	});

	it("leaves a live listener that is our binary", async () => {
		const dir = tempHome();
		const phone = deps(dir, {
			isAlive: (pid) => pid === 50,
			verdict: () => "ours",
		});
		writeRaw(listenerPidPath(phone.paths), JSON.stringify({ pid: 50, since: 1, hook: null }));
		let spawned = 0;
		phone.spawnListener = () => {
			spawned += 1;
			return 1;
		};

		const result = await ensureListener(phone);

		expect(result).toEqual({ pid: 50, status: "running" });
		expect(spawned).toBe(0);
	});

	it("leaves a live pid whose command line cannot be read", async () => {
		const dir = tempHome();
		const phone = deps(dir, {
			isAlive: () => true,
			verdict: () => "unknown",
		});
		writeRaw(listenerPidPath(phone.paths), JSON.stringify({ pid: 77, since: 1, hook: null }));
		let spawned = 0;
		phone.spawnListener = () => {
			spawned += 1;
			return 1;
		};

		expect(await ensureListener(phone)).toEqual({ pid: 77, status: "running" });
		expect(spawned).toBe(0);
	});

	it("starts when a live pid is not our binary and does not kill it", async () => {
		const dir = tempHome();
		const killed: number[] = [];
		const phone = deps(dir, {
			isAlive: (pid) => pid === process.pid || pid === 6200,
			verdict: (pid) => (pid === 6200 ? "ours" : "foreign"),
			spawnListener: () => 6200,
		});
		writeRaw(listenerPidPath(phone.paths), JSON.stringify({ pid: process.pid, since: 1, hook: null }));

		const result = await ensureListener(phone);

		expect(result).toEqual({ pid: 6200, status: "started" });
		expect(killed).toEqual([]);
		expect(JSON.parse(readFileSync(listenerPidPath(phone.paths), "utf8")).pid).toBe(6200);
	});

	it("takes over a lock whose holder is dead", async () => {
		const dir = tempHome();
		const phone = deps(dir);
		writeRaw(ensureLockPath(phone.paths), "999999");
		phone.spawnListener = () => 6300;

		expect(await ensureListener(phone)).toEqual({ pid: 6300, status: "started" });
	});

	it("does not start a second listener while another ensure holds the lock", async () => {
		const dir = tempHome();
		const alive = new Set<number>([process.pid]);
		let spawns = 0;
		let held = false;
		let releaseHold = () => {};
		const waiters: Array<() => void> = [];
		const phone = deps(dir, {
			sleep: (ms) =>
				new Promise((resolve) => {
					if (ms === 0 && !held) {
						held = true;
						releaseHold = resolve;
						return;
					}
					if (ms === 0) {
						resolve();
						return;
					}
					waiters.push(resolve);
				}),
			isAlive: (pid) => alive.has(pid),
			verdict: (pid) => (pid === 7000 ? "ours" : "foreign"),
			spawnListener: () => {
				spawns += 1;
				alive.add(7000);
				return 7000;
			},
		});

		const first = ensureListener(phone);
		for (let i = 0; i < 5; i += 1) await Promise.resolve();
		const second = ensureListener(phone);
		for (let i = 0; i < 5; i += 1) await Promise.resolve();
		releaseHold();
		await first;
		for (const resume of waiters) resume();
		await second;

		expect(spawns).toBe(1);
	});

	it("starts when the pidfile is missing even if a verdict would refuse a live pid", async () => {
		const dir = tempHome();
		let spawned = 0;
		const phone = deps(dir, {
			isAlive: () => false,
			verdict: () => {
				throw new Error("verdict");
			},
			spawnListener: () => {
				spawned += 1;
				return 6500;
			},
		});

		expect(await ensureListener(phone)).toEqual({ pid: 6500, status: "started" });
		expect(spawned).toBe(1);
	});

	it("does not treat a non-numeric lock as a dead holder", async () => {
		const dir = tempHome();
		const phone = deps(dir, { isAlive: () => false });
		writeRaw(ensureLockPath(phone.paths), "not-a-pid");
		let spawned = 0;
		phone.spawnListener = () => {
			spawned += 1;
			return 1;
		};

		await expect(ensureListener(phone)).rejects.toThrow("phone open --ensure is already running");
		expect(spawned).toBe(0);
	});

	it("reads only a safe positive pid out of listener.pid", () => {
		const dir = tempHome();
		const phone = deps(dir);
		expect(readRecordedPid(phone.paths)).toBeUndefined();
		writeRaw(listenerPidPath(phone.paths), "not json");
		expect(readRecordedPid(phone.paths)).toBeUndefined();
		for (const pid of [0, -4, 1.5, "12"]) {
			writeRaw(listenerPidPath(phone.paths), JSON.stringify({ pid }));
			expect(readRecordedPid(phone.paths)).toBeUndefined();
		}
		writeRaw(listenerPidPath(phone.paths), JSON.stringify({ pid: 12 }));
		expect(readRecordedPid(phone.paths)).toBe(12);
	});

	it("waits out a live lock instead of starting beside it", async () => {
		const dir = tempHome();
		const phone = deps(dir, { isAlive: (pid) => pid === process.pid });
		writeRaw(ensureLockPath(phone.paths), String(process.pid));
		let spawned = 0;
		phone.spawnListener = () => {
			spawned += 1;
			return 1;
		};

		await expect(ensureListener(phone)).rejects.toThrow("phone open --ensure is already running");
		expect(spawned).toBe(0);
	});
});

describe("ensure cron line", () => {
	it("quotes the command, jitters with RANDOM, and never includes a message body", () => {
		const line = ensureCronLine(["/opt/dg agent", "phone", "open", "--ensure"], "/home/a");

		expect(line.startsWith(`*/5 * * * * sleep $((RANDOM % ${CRON_JITTER_SECONDS})); `)).toBe(true);
		expect(line).toContain(`DG_HOME=${shQuote("/home/a")}`);
		expect(line).toContain(`'/opt/dg agent' 'phone' 'open' '--ensure'`);
		expect(line.endsWith(`# ${CRON_MARKER}`)).toBe(true);
		expect(line).not.toContain("nsec");
		expect(line).not.toContain("hello");
		expect(ensureCronLine(["/bin/dg-agent", "phone", "open", "--ensure"])).not.toContain("DG_HOME");
		expect(shQuote("a'b")).toBe(`'a'\\''b'`);
	});

	it("builds phone open --ensure from the listener argv", () => {
		expect(openEnsureArgv((extra) => ["/usr/bin/bun", "/src/index.ts", "phone", "__run", ...extra])).toEqual([
			"/usr/bin/bun",
			"/src/index.ts",
			"phone",
			"open",
			"--ensure",
		]);
		expect(openEnsureArgv(() => ["bun", "index.ts"])).toEqual(["phone", "open", "--ensure"]);
	});

	it("replaces an older ensure line and keeps the rest of the crontab", () => {
		const line = ensureCronLine(["/bin/dg-agent", "phone", "open", "--ensure"]);
		const merged = mergeCrontab(`0 * * * * echo keep\n*/5 * * * * old # ${CRON_MARKER}\n`, line);

		expect(merged).toContain("echo keep");
		expect(merged).not.toContain("old");
		expect(merged.match(new RegExp(CRON_MARKER, "g"))).toHaveLength(1);
		expect(mergeCrontab(merged, line)).toBe(merged);
	});

	it("installs into an empty crontab and refuses a list failure that is not 'no crontab'", async () => {
		const line = ensureCronLine(["/bin/dg-agent", "phone", "open", "--ensure"]);
		const replaced: string[] = [];
		const empty: CrontabIO = {
			list: async () => ({ code: 1, stdout: "", stderr: "no crontab for user" }),
			replace: async (text) => {
				replaced.push(text);
				return { code: 0, stdout: "", stderr: "" };
			},
		};

		await installCrontabLine(line, empty);
		expect(replaced).toEqual([`${line}\n`]);

		const broken: CrontabIO = {
			list: async () => ({ code: 1, stdout: "", stderr: "permission denied" }),
			replace: async () => ({ code: 0, stdout: "", stderr: "" }),
		};
		await expect(installCrontabLine(line, broken)).rejects.toThrow("crontab -l failed: permission denied");

		const padded: CrontabIO = {
			list: async () => ({ code: 1, stdout: "", stderr: "  permission denied  \nmore" }),
			replace: async () => ({ code: 0, stdout: "", stderr: "" }),
		};
		await expect(installCrontabLine(line, padded)).rejects.toThrow("crontab -l failed: permission denied");

		const junkStdout: CrontabIO = {
			list: async () => ({ code: 1, stdout: "evil line\n", stderr: "no crontab for user" }),
			replace: async (text) => {
				replaced.push(text);
				return { code: 0, stdout: "", stderr: "" };
			},
		};
		await installCrontabLine(line, junkStdout);
		expect(replaced.at(-1)).not.toContain("evil");

		const replaceFails: CrontabIO = {
			list: async () => ({ code: 0, stdout: "", stderr: "" }),
			replace: async () => ({ code: 1, stdout: "", stderr: "crontab: install refused\nsecond" }),
		};
		await expect(installCrontabLine(line, replaceFails)).rejects.toThrow("crontab install failed: crontab: install refused");
	});
});

describe("phone open --ensure", () => {
	function harness(overrides: Partial<OpenCloseDeps> = {}) {
		const dir = tracker.freshHome();
		const paths = resolveDgPaths({ env: { DG_HOME: dir } });
		const db = PhoneDb.open(paths, () => 1_700_000_000);
		tracker.trackDb(db);
		const out: string[] = [];
		const spawned: { argv: string[]; logPath: string }[] = [];
		const ran: string[][] = [];
		const replaced: string[] = [];
		const deps: OpenCloseDeps = {
			paths,
			db,
			sessionClient: async () => undefined,
			grantClient: (): KeyClient => {
				throw new Error("no grant");
			},
			createPool: () => {
				throw new Error("ensure does not open a relay");
			},
			write: (text) => out.push(text),
			readStdin: async () => undefined,
			now: () => 1_700_000_000,
			platform: "linux",
			homeDir: dir,
			env: {},
			uid: 501,
			writeFile: () => {},
			removeFile: () => {},
			fileExists: () => false,
			run: async (argv) => {
				ran.push(argv);
				return { code: 0, stdout: "", stderr: "" };
			},
			which: () => "/bin/true",
			listenerArgv: (extra) => ["/fake/dg-agent", "phone", "__run", ...extra],
			spawnListener: (argv, logPath) => {
				spawned.push({ argv, logPath });
				return 6400;
			},
			kill: () => {},
			isOurListener: () => true,
			sleep: async () => {},
			isAlive: (pid) => pid === 6400,
			verdict: (pid) => (pid === 6400 ? "ours" : "foreign"),
			crontab: {
				list: async () => ({ code: 0, stdout: "0 * * * * echo keep\n", stderr: "" }),
				replace: async (text) => {
					replaced.push(text);
					return { code: 0, stdout: "", stderr: "" };
				},
			},
			...overrides,
		};
		return { deps, out, spawned, ran, replaced };
	}

	it("starts a detached listener without systemd and without touching the crontab", async () => {
		const h = harness();
		delete h.deps.env.DBUS_SESSION_BUS_ADDRESS;
		delete h.deps.env.XDG_RUNTIME_DIR;

		await phoneOpen({ ensure: true }, h.deps);
		expect(parseNdjson(h.out)[0]).toMatchObject({ pid: 6400, status: "started", autostart: "ensure", hook: null });
		expect(h.ran).toEqual([]);
		expect(h.replaced).toEqual([]);
		expect(h.spawned).toHaveLength(1);
		expect(h.spawned[0]?.argv).toEqual(["/fake/dg-agent", "phone", "__run"]);

		h.out.length = 0;
		await phoneOpen({ ensure: true }, h.deps);
		expect(parseNdjson(h.out)[0]).toMatchObject({ pid: 6400, status: "running", autostart: "ensure" });
		expect(h.spawned).toHaveLength(1);
	});

	it("prints the cron line without installing it, and installs only when asked", async () => {
		const h = harness();

		await phoneOpen({ printCron: true }, h.deps);
		const printed = parseNdjson(h.out)[0] as { cron: string; cron_installed?: boolean };
		expect(printed.cron).toContain("'phone' 'open' '--ensure'");
		expect(printed.cron).toContain(CRON_MARKER);
		expect(printed.cron_installed).toBeUndefined();
		expect(h.replaced).toEqual([]);
		expect(h.spawned).toEqual([]);

		h.out.length = 0;
		await phoneOpen({ installCron: true }, h.deps);
		expect(h.replaced).toHaveLength(1);
		expect(h.replaced[0]).toContain("echo keep");
		expect(h.replaced[0]).toContain(CRON_MARKER);
		expect(parseNdjson(h.out)[0]).toMatchObject({ cron_installed: true });
		expect(h.spawned).toEqual([]);
	});
});

describe("spawnDetachedListener", () => {
	it("puts the child in its own session", () => {
		const dir = tempHome();
		const pid = spawnDetachedListener(["/bin/sleep", "30"], join(dir, "listener.log"));
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
			expect(Number(rest[3])).toBe(pid);
		} finally {
			try {
				process.kill(pid, "SIGTERM");
			} catch {}
		}
	});
});
