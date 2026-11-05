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

describe("file lock takeover", () => {
	it("keeps a lock whose holder is alive even when it is past the stale window", () => {
		const path = plantLock(JSON.stringify({ pid: process.pid, host: hostname(), id: "x" }));
		expect(tryFileLock(root, NAME)).toBeUndefined();
		expect(tryFileLock(root, NAME)).toBeUndefined();
		expect(existsSync(path)).toBe(true);
	});

	it("takes over a live-pid lock older than the hard ceiling", () => {
		plantLock(JSON.stringify({ pid: process.pid, host: hostname(), id: "x" }), 11 * 60);
		tryFileLock(root, NAME);
		const release = tryFileLock(root, NAME);
		expect(release).toBeFunction();
		release?.();
	});

	it("keeps a live-pid lock whose heartbeat is inside the hard ceiling", () => {
		const path = plantLock(JSON.stringify({ pid: process.pid, host: hostname(), id: "x" }), 9 * 60);
		expect(tryFileLock(root, NAME)).toBeUndefined();
		expect(tryFileLock(root, NAME)).toBeUndefined();
		expect(existsSync(path)).toBe(true);
	});

	it("takes over a lock whose holder pid is dead", () => {
		plantLock(JSON.stringify({ pid: deadPid(), host: hostname(), id: "x" }), 0);
		tryFileLock(root, NAME);
		const release = tryFileLock(root, NAME);
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
