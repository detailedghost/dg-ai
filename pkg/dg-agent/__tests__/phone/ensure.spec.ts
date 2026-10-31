import { afterEach, describe, expect, it } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAlive, resolveDgPaths } from "@dg/common/node";
import { phoneOpen, type OpenCloseDeps } from "../../src/phone/commands";
import { PhoneDb } from "../../src/phone/db";
import {
	CRON_MARKER,
	ENSURE_EMPTY_LOCK_MS,
	ENSURE_LOCK_MAX_AGE_MS,
	type CrontabIO,
	commandOwnsEnsure,
	cronJitterCommand,
	cronShellCommand,
	ensureCronLine,
	ensureListener,
	ensureLockPath,
	ensureLockStale,
	ensureMarker,
	type EnsureDeps,
	installCrontabLine,
	isNewerVersion,
	mergeCrontab,
	openEnsureArgv,
	ownsEnsureProcess,
	readRecordedPid,
	releaseEnsureLock,
	shQuote,
	shouldEnsureRestart,
	shouldReplaceListener,
} from "../../src/phone/ensure";
import type { KeyClient } from "../../src/phone/keys";
import { listenerPidPath, spawnDetachedListener } from "../../src/phone/listener";
import { DG_AGENT_PACKAGE_VERSION } from "../../src/version";
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
		nowMs: () => Date.now(),
		sleep: async () => {},
		isAlive: () => false,
		verdict: () => "foreign",
		ownsProcess: () => true,
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
		const phone = deps(dir, { verdict: () => "ours", isAlive: (pid) => pid === 6100 });
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
		const phone = deps(dir, { isAlive: (pid) => pid === 6300 });
		writeRaw(ensureLockPath(phone.paths), "999999");
		phone.spawnListener = () => 6300;

		expect(await ensureListener(phone)).toEqual({ pid: 6300, status: "started" });
	});

	it("takes over an empty lock only after it has aged, and a lock whose live pid is not our process", async () => {
		const dir = tempHome();
		const empty = deps(dir, { isAlive: (pid) => pid === 6310 });
		const emptyPath = ensureLockPath(empty.paths);
		writeRaw(emptyPath, "");
		empty.spawnListener = () => 6310;
		await expect(ensureListener(empty)).rejects.toThrow("already running");

		const old = new Date(Date.now() - 2_000);
		utimesSync(emptyPath, old, old);
		expect(await ensureListener(empty)).toEqual({ pid: 6310, status: "started" });

		const reused = deps(dir, { isAlive: (pid) => pid === 6311, ownsProcess: () => false });
		writeRaw(ensureLockPath(reused.paths), "12345");
		reused.spawnListener = () => 6311;
		expect(await ensureListener(reused)).toEqual({ pid: 6311, status: "started" });
	});

	it("takes over a lock that is older than the max age", async () => {
		const dir = tempHome();
		const phone = deps(dir, { isAlive: () => true, ownsProcess: () => true });
		const path = ensureLockPath(phone.paths);
		writeRaw(path, String(process.pid));
		const old = new Date(Date.now() - 60_000);
		utimesSync(path, old, old);
		phone.spawnListener = () => 6320;

		expect(await ensureListener(phone)).toEqual({ pid: 6320, status: "started" });
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
			ownsProcess: (pid) => (pid === process.pid ? true : undefined),
			spawnListener: () => {
				spawns += 1;
				alive.add(7000);
				return 7000;
			},
		});

		const first = ensureListener(phone);
		for (let i = 0; i < 5; i += 1) await Promise.resolve();
		expect(readFileSync(ensureLockPath(phone.paths), "utf8")).toBe(String(process.pid));
		const second = ensureListener(phone);
		for (let i = 0; i < 5; i += 1) await Promise.resolve();
		releaseHold();
		await first;
		for (const resume of waiters) resume();
		await second;

		expect(spawns).toBe(1);
		expect(existsSync(ensureLockPath(phone.paths))).toBe(false);
	});

	it("starts when the pidfile is missing even if a verdict would refuse a live pid", async () => {
		const dir = tempHome();
		let spawned = 0;
		const phone = deps(dir, {
			isAlive: (pid) => pid === 6500,
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

	it("takes over a lock whose contents are not a pid once it is a second old", async () => {
		const dir = tempHome();
		const phone = deps(dir, { isAlive: (pid) => pid === 6330 });
		const path = ensureLockPath(phone.paths);
		writeRaw(path, "not-a-pid");
		phone.spawnListener = () => 6330;
		await expect(ensureListener(phone)).rejects.toThrow("already running");

		const old = new Date(Date.now() - 2_000);
		utimesSync(path, old, old);
		expect(await ensureListener(phone)).toEqual({ pid: 6330, status: "started" });
	});

	it("recognizes this binary or a phone listener, and not an unrelated process", () => {
		expect(commandOwnsEnsure(["/bin/dg-agent", "phone", "open", "--ensure"], "/bin/dg-agent")).toBe(true);
		expect(commandOwnsEnsure(["node", "phone", "__run"], undefined)).toBe(true);
		expect(commandOwnsEnsure(["node", "phone", "open"], undefined)).toBe(true);
		expect(commandOwnsEnsure(["node", "phone", "inbox"], undefined)).toBe(false);
		expect(commandOwnsEnsure(["/bin/sleep", "30"], "/bin/dg-agent")).toBe(false);
		expect(ownsEnsureProcess(process.pid, "/bin/dg-agent")).toBe(false);
		expect(ownsEnsureProcess(999_999_999, "/bin/dg-agent")).toBeUndefined();
	});

	it("replaces a missing, dead, or foreign listener and keeps a live one of ours", () => {
		expect(shouldReplaceListener(undefined, false, "ours")).toBe(true);
		expect(shouldReplaceListener(4, false, "ours")).toBe(true);
		expect(shouldReplaceListener(4, true, "ours")).toBe(false);
		expect(shouldReplaceListener(4, true, "unknown")).toBe(false);
		expect(shouldReplaceListener(4, true, "foreign")).toBe(true);
	});

	it("breaks an empty, dead, foreign, or expired lock and keeps a young lock of ours", () => {
		const dir = tempHome();
		const path = ensureLockPath(deps(dir).paths);
		writeRaw(path, "");
		const mtime = statSync(path).mtimeMs;
		const young = { isAlive: () => true, ownsProcess: () => true as boolean | undefined, nowMs: () => mtime };
		expect(ensureLockStale(path, young)).toBe(false);
		expect(ensureLockStale(path, { ...young, nowMs: () => mtime + ENSURE_EMPTY_LOCK_MS - 1 })).toBe(false);
		expect(ensureLockStale(path, { ...young, nowMs: () => mtime + ENSURE_EMPTY_LOCK_MS })).toBe(true);
		writeRaw(path, "0");
		const zero = statSync(path).mtimeMs;
		expect(ensureLockStale(path, { ...young, nowMs: () => zero })).toBe(false);
		expect(ensureLockStale(path, { ...young, nowMs: () => zero + ENSURE_EMPTY_LOCK_MS })).toBe(true);
		writeRaw(path, "42");
		expect(ensureLockStale(path, { ...young, isAlive: () => false })).toBe(true);
		expect(ensureLockStale(path, { ...young, ownsProcess: () => false })).toBe(true);
		expect(ensureLockStale(path, { ...young, ownsProcess: () => undefined })).toBe(false);
		const held = statSync(path).mtimeMs;
		expect(ensureLockStale(path, { ...young, nowMs: () => held + ENSURE_LOCK_MAX_AGE_MS })).toBe(true);
		expect(ensureLockStale(path, { ...young, nowMs: () => held + ENSURE_LOCK_MAX_AGE_MS - 1 })).toBe(false);
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

	it("puts a lock back when it stops being stale after the rename, and does not delete another pid's lock", async () => {
		const dir = tempHome();
		const path = ensureLockPath(deps(dir).paths);
		writeRaw(path, "");
		const written = statSync(path).mtimeMs;
		let reads = 0;
		let spawned = 0;
		const phone = deps(dir, {
			nowMs: () => {
				reads += 1;
				return reads === 1 ? written + 5_000 : written;
			},
			isAlive: (pid) => pid === 6600,
			spawnListener: () => {
				spawned += 1;
				return 6600;
			},
		});

		await expect(ensureListener(phone)).rejects.toThrow("already running");
		expect(spawned).toBe(0);
		expect(existsSync(path)).toBe(true);
		expect(readFileSync(path, "utf8")).toBe("");
		expect(readdirSync(phone.paths.phoneRoot).filter((name) => name.startsWith("ensure.lock."))).toEqual([]);

		writeFileSync(path, String(process.pid));
		releaseEnsureLock(path, process.pid);
		expect(existsSync(path)).toBe(false);
		writeFileSync(path, "4242");
		releaseEnsureLock(path, process.pid);
		expect(readFileSync(path, "utf8")).toBe("4242");
		releaseEnsureLock(path, 4242);
		expect(existsSync(path)).toBe(false);
	});

	it("does not record a listener that has already exited, and does record a live sleep", async () => {
		const dir = tempHome();
		const dead = deps(dir, { isAlive: () => false, spawnListener: () => 424242 });
		await expect(ensureListener(dead)).rejects.toThrow("exited before it could be recorded");
		expect(existsSync(listenerPidPath(dead.paths))).toBe(false);
		expect(existsSync(ensureLockPath(dead.paths))).toBe(false);

		const child = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
		const pid = child.pid;
		if (pid === undefined) throw new Error("sleep did not start");
		try {
			const phone = deps(dir, { isAlive, spawnListener: () => pid });
			expect(await ensureListener(phone)).toEqual({ pid, status: "started" });
			expect(JSON.parse(readFileSync(listenerPidPath(phone.paths), "utf8")).pid).toBe(pid);
		} finally {
			try {
				process.kill(pid, "SIGTERM");
			} catch {}
		}
	});

	it("does not delete a lock another ensure wrote while this one held it", async () => {
		const dir = tempHome();
		let releaseHold = () => {};
		const phone = deps(dir, {
			sleep: (ms) =>
				new Promise((resolve) => {
					if (ms === 0) {
						releaseHold = resolve;
						return;
					}
					resolve();
				}),
			isAlive: (pid) => pid === 6700,
			spawnListener: () => 6700,
		});
		const pending = ensureListener(phone);
		for (let i = 0; i < 5; i += 1) await Promise.resolve();
		const path = ensureLockPath(phone.paths);
		expect(readFileSync(path, "utf8")).toBe(String(process.pid));
		writeFileSync(path, "4242");
		releaseHold();
		await pending;
		expect(readFileSync(path, "utf8")).toBe("4242");
	});
});

describe("ensure cron line", () => {
	it("quotes the command, jitters without a percent, and never includes a message body", () => {
		const line = ensureCronLine(["/opt/dg agent", "phone", "open", "--ensure"], "/home/a");

		expect(cronJitterCommand()).toBe("sleep $(( $(od -An -N2 -tu2 /dev/urandom) / 1093 ))");
		expect(line.startsWith(`*/5 * * * * ${cronJitterCommand()}; `)).toBe(true);
		expect(line).toContain(`DG_HOME=${shQuote("/home/a")}`);
		expect(line).toContain(`'/opt/dg agent' 'phone' 'open' '--ensure'`);
		expect(line.endsWith("# dg-phone-ensure home=/home/a")).toBe(true);
		expect(line).not.toContain("%");
		expect(line).not.toContain("$RANDOM");
		expect(line).not.toContain("nsec");
		expect(line).not.toContain("hello");
		const bare = ensureCronLine(["/bin/dg-agent", "phone", "open", "--ensure"]);
		expect(bare.endsWith("# dg-phone-ensure home=")).toBe(true);
		expect(bare).not.toContain("DG_HOME=");
		expect(shQuote("a'b")).toBe(`'a'\\''b'`);
		expect(cronShellCommand("* * * * * echo a\\%b%c")).toBe("echo a%b");
		expect(cronShellCommand("nospace")).toBe("");
	});

	it("runs the command cron keeps, under dash -n and for real", () => {
		const dir = tempHome();
		const bin = join(dir, "bin");
		mkdirSync(bin);
		const od = join(bin, "od");
		writeFileSync(od, "#!/bin/sh\necho 0\n");
		chmodSync(od, 0o755);
		const stamp = join(dir, "stamp");
		const stub = join(dir, "dg-agent");
		writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > '${stamp}'\n`);
		chmodSync(stub, 0o755);
		const line = ensureCronLine([stub, "phone", "open", "--ensure"], "/tmp/dg-home");
		const command = cronShellCommand(line);

		expect(command).not.toContain("%");
		expect(spawnSync("dash", ["-n", "-c", command]).status).toBe(0);
		const ran = spawnSync("dash", ["-c", command], {
			env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
		});
		expect(ran.status).toBe(0);
		expect(readFileSync(stamp, "utf8")).toBe("phone\nopen\n--ensure\n");
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

	it("replaces an older ensure line for the same home, keeps blank lines, and leaves another home", () => {
		const line = ensureCronLine(["/bin/dg-agent", "phone", "open", "--ensure"], "/home/a");
		const other = ensureCronLine(["/bin/dg-agent", "phone", "open", "--ensure"], "/home/b");
		const marker = ensureMarker("/home/a");
		const merged = mergeCrontab(`0 * * * * echo keep\n\n*/5 * * * * old # ${marker}\n${other}\n`, line, marker);

		expect(merged).toContain("echo keep");
		expect(merged).toContain("\n\n");
		expect(merged).not.toContain("old");
		expect(merged).toContain(ensureMarker("/home/b"));
		expect(merged.split(marker).length - 1).toBe(1);
		expect(mergeCrontab(merged, line, marker)).toBe(merged);
		expect(line).toContain(CRON_MARKER);

		const longer = ensureCronLine(["/bin/dg-agent", "phone", "open", "--ensure"], "/home/ab");
		const reinstalled = mergeCrontab(`${longer}\n${line}\n`, line, marker);
		const rows = reinstalled.split("\n").filter((row) => row.length > 0);
		expect(rows.filter((row) => row.endsWith("# dg-phone-ensure home=/home/ab"))).toHaveLength(1);
		expect(rows.filter((row) => row.endsWith("# dg-phone-ensure home=/home/a"))).toHaveLength(1);

		const emptyHome = ensureCronLine(["/bin/dg-agent", "phone", "open", "--ensure"]);
		const keptHomes = mergeCrontab(`${line}\n${longer}\n`, emptyHome, ensureMarker());
		expect(keptHomes).toContain("home=/home/a");
		expect(keptHomes).toContain("home=/home/ab");
		expect(keptHomes.endsWith(`${emptyHome}\n`)).toBe(true);
		const mentioned = `0 * * * * echo ${marker} stays`;
		expect(mergeCrontab(`${mentioned}\n`, line, marker)).toContain("stays");
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

		const blankList: CrontabIO = {
			list: async () => ({ code: 2, stdout: "", stderr: "" }),
			replace: async () => ({ code: 0, stdout: "", stderr: "" }),
		};
		await expect(installCrontabLine(line, blankList)).rejects.toThrow("crontab -l failed: exit 2");

		const blankReplace: CrontabIO = {
			list: async () => ({ code: 0, stdout: "", stderr: "" }),
			replace: async () => ({ code: 3, stdout: "", stderr: "" }),
		};
		await expect(installCrontabLine(line, blankReplace)).rejects.toThrow("crontab install failed: exit 3");

		const older = `*/5 * * * * old-command # ${ensureMarker("/home/a")}`;
		const homeLine = ensureCronLine(["/bin/dg-agent", "phone", "open", "--ensure"], "/home/a");
		const replacedHome: string[] = [];
		await installCrontabLine(homeLine, {
			list: async () => ({ code: 0, stdout: `${older}\n`, stderr: "" }),
			replace: async (text) => {
				replacedHome.push(text);
				return { code: 0, stdout: "", stderr: "" };
			},
		});
		expect(replacedHome[0]).not.toContain("old-command");
		expect(replacedHome[0]).toContain("home=/home/a");
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

	it("restarts a listener whose recorded version is not this binary", async () => {
		const h = harness();
		writeFileSync(
			listenerPidPath(h.deps.paths),
			JSON.stringify({ pid: process.pid, since: 1, hook: null, version: "0.0.0" }),
		);
		h.deps.kill = () => {
			rmSync(listenerPidPath(h.deps.paths), { force: true });
		};

		await phoneOpen({ ensure: true }, h.deps);

		expect(h.spawned).toHaveLength(1);
		expect(parseNdjson(h.out)[0]).toMatchObject({ status: "restarted", autostart: "ensure" });
		expect(DG_AGENT_PACKAGE_VERSION).not.toBe("0.0.0");
	});

	it("leaves a listener recorded at this version", async () => {
		const h = harness();
		h.deps.isAlive = (pid) => pid === process.pid;
		h.deps.verdict = () => "ours";
		writeFileSync(
			listenerPidPath(h.deps.paths),
			JSON.stringify({ pid: process.pid, since: 1, hook: null, version: DG_AGENT_PACKAGE_VERSION }),
		);

		await phoneOpen({ ensure: true }, h.deps);

		expect(h.spawned).toEqual([]);
		expect(parseNdjson(h.out)[0]).toMatchObject({ pid: process.pid, status: "running" });
	});

	it("does not replace a newer listener, and does replace key drift at this version", async () => {
		const newer = harness();
		newer.deps.isAlive = (pid) => pid === process.pid;
		newer.deps.verdict = () => "ours";
		writeFileSync(
			listenerPidPath(newer.deps.paths),
			JSON.stringify({ pid: process.pid, since: 1, hook: null, version: "99.0.0" }),
		);
		await phoneOpen({ ensure: true }, newer.deps);
		expect(newer.spawned).toEqual([]);
		expect(parseNdjson(newer.out)[0]).toMatchObject({ pid: process.pid, status: "running" });

		const named = harness();
		named.deps.isAlive = (pid) => pid === process.pid;
		named.deps.verdict = () => "ours";
		writeFileSync(
			listenerPidPath(named.deps.paths),
			JSON.stringify({ pid: process.pid, since: 1, hook: null, version: "latest" }),
		);
		await phoneOpen({ ensure: true }, named.deps);
		expect(named.spawned).toEqual([]);

		const missing = harness();
		missing.deps.isAlive = (pid) => pid === process.pid || pid === 6400;
		missing.deps.verdict = () => "ours";
		missing.deps.kill = () => {
			rmSync(listenerPidPath(missing.deps.paths), { force: true });
		};
		writeFileSync(listenerPidPath(missing.deps.paths), JSON.stringify({ pid: process.pid, since: 1, hook: null }));
		await phoneOpen({ ensure: true }, missing.deps);
		expect(missing.spawned).toHaveLength(1);
		expect(parseNdjson(missing.out)[0]).toMatchObject({ status: "restarted" });

		const keys = harness();
		keys.deps.isAlive = (pid) => pid === process.pid || pid === 6400;
		keys.deps.verdict = () => "ours";
		keys.deps.kill = () => {
			rmSync(listenerPidPath(keys.deps.paths), { force: true });
		};
		writeFileSync(
			listenerPidPath(keys.deps.paths),
			JSON.stringify({ pid: process.pid, since: 1, hook: null, version: DG_AGENT_PACKAGE_VERSION, keys: "different" }),
		);
		await phoneOpen({ ensure: true }, keys.deps);
		expect(keys.spawned).toHaveLength(1);
		expect(parseNdjson(keys.out)[0]).toMatchObject({ status: "restarted" });

		expect(shouldEnsureRestart("1.2.0", "1.2.0")).toBe(true);
		expect(shouldEnsureRestart("1.2.0", "1.0.0")).toBe(true);
		expect(shouldEnsureRestart("1.2.0", "9.0.0")).toBe(false);
		expect(shouldEnsureRestart("1.2.0", undefined)).toBe(true);
		expect(shouldEnsureRestart("1.2.0", "")).toBe(true);
		expect(shouldEnsureRestart("1.2.0", "latest")).toBe(false);
		expect(isNewerVersion("1.10.0", "1.9.0")).toBe(true);
		expect(isNewerVersion("2.0.0", "1.9.9")).toBe(true);
		expect(isNewerVersion("1.2.0", "1.2.1")).toBe(false);
		expect(isNewerVersion("1.2", "1.2.0")).toBe(false);
		expect(isNewerVersion("1.2.3", "1.2.3")).toBe(false);
		expect(isNewerVersion("latest", "1.0.0")).toBe(false);
		expect(isNewerVersion("1.2.0", "1.2.0-dev")).toBe(false);
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
