import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { tryFileLock, withFileLock } from "../../src/phone/file-lock";

const NAME = "test.lock";
const OLD = (Date.now() - 60_000) / 1000;

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "file-lock-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function plantLock(content: string, ageSeconds = 60): string {
	const path = join(root, NAME);
	writeFileSync(path, content);
	const when = Date.now() / 1000 - ageSeconds;
	utimesSync(path, when, when);
	return path;
}

function deadPid(): number {
	const child = Bun.spawnSync(["true"]);
	return child.pid;
}

const START = "start-a";
const startedAt = (start: string | undefined) => () => start;

function holder(extra: Record<string, unknown> = {}): string {
	return JSON.stringify({ pid: process.pid, host: hostname(), start: START, id: "x", ...extra });
}

describe("file lock takeover", () => {
	it("keeps a lock whose holder is alive even when it is past the stale window", () => {
		const path = plantLock(holder());
		expect(tryFileLock(root, NAME, startedAt(START))).toBeUndefined();
		expect(tryFileLock(root, NAME, startedAt(START))).toBeUndefined();
		expect(existsSync(path)).toBe(true);
	});

	it("keeps a live sync holder that has held the lock for more than 10 minutes", () => {
		const path = plantLock(holder(), 11 * 60);
		expect(tryFileLock(root, NAME, startedAt(START))).toBeUndefined();
		expect(tryFileLock(root, NAME, startedAt(START))).toBeUndefined();
		expect(readFileSync(path, "utf8")).toBe(holder());
	});

	it("takes over a lock whose pid was reused by a process with a different start time", () => {
		plantLock(holder(), 0);
		tryFileLock(root, NAME, startedAt("start-b"));
		const release = tryFileLock(root, NAME, startedAt("start-b"));
		expect(release).toBeFunction();
		release?.();
	});

	it("keeps a live-pid lock older than 10 minutes when the start time cannot be read", () => {
		const path = plantLock(holder(), 11 * 60);
		expect(tryFileLock(root, NAME, startedAt(undefined))).toBeUndefined();
		expect(tryFileLock(root, NAME, startedAt(undefined))).toBeUndefined();
		expect(existsSync(path)).toBe(true);
	});

	it("records the holder start time with its pid and host", () => {
		const release = tryFileLock(root, NAME, startedAt(START));
		expect(JSON.parse(readFileSync(join(root, NAME), "utf8"))).toMatchObject({ pid: process.pid, host: hostname(), start: START });
		release?.();
	});

	it("takes over a lock whose holder pid is dead", () => {
		plantLock(holder({ pid: deadPid() }), 0);
		tryFileLock(root, NAME, startedAt(START));
		const release = tryFileLock(root, NAME, startedAt(START));
		expect(release).toBeFunction();
		release?.();
	});

	it("takes over an unreadable lock older than the stale window", () => {
		plantLock("not json");
		tryFileLock(root, NAME);
		const release = tryFileLock(root, NAME);
		expect(release).toBeFunction();
		release?.();
	});

	it("keeps a fresh unreadable lock", () => {
		plantLock("not json", 0);
		expect(tryFileLock(root, NAME)).toBeUndefined();
		expect(tryFileLock(root, NAME)).toBeUndefined();
	});

	it("keeps an old lock held from another host until the stale window passes", () => {
		plantLock(JSON.stringify({ pid: deadPid(), host: `${hostname()}-other`, id: "x" }), 0);
		expect(tryFileLock(root, NAME)).toBeUndefined();
		expect(tryFileLock(root, NAME)).toBeUndefined();
	});
});

describe("withFileLock heartbeat", () => {
	it("refreshes the lock mtime while work runs and clears the timer afterward", async () => {
		let beat: (() => void) | undefined;
		const timers = spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void) => {
			beat = fn;
			return { unref() {} } as unknown as ReturnType<typeof setInterval>;
		}) as unknown as typeof setInterval);
		const cleared = spyOn(globalThis, "clearInterval");
		try {
			await withFileLock(root, NAME, "busy", async () => {
				const path = join(root, NAME);
				utimesSync(path, OLD, OLD);
				beat?.();
				expect(statSync(path).mtimeMs).toBeGreaterThan(Date.now() - 5_000);
				expect(readFileSync(path, "utf8")).toContain(String(process.pid));
			});
			expect(cleared).toHaveBeenCalledTimes(1);
			expect(existsSync(join(root, NAME))).toBe(false);
		} finally {
			timers.mockRestore();
			cleared.mockRestore();
		}
	});
});
