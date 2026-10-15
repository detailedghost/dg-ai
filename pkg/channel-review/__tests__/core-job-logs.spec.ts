import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneJobLogs } from "../src/job-logs";

const DAY_MS = 24 * 3_600_000;
const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function jobsDir(files: Record<string, number>, now: Date): string {
	const dir = mkdtempSync(join(tmpdir(), "cr-jobs-"));
	dirs.push(dir);
	for (const [name, ageDays] of Object.entries(files)) {
		const file = join(dir, name);
		writeFileSync(file, "log");
		const at = new Date(now.getTime() - ageDays * DAY_MS);
		utimesSync(file, at, at);
	}
	return dir;
}

describe("pruneJobLogs", () => {
	const now = new Date();

	test("deletes logs older than 14 days and keeps newer ones", () => {
		const dir = jobsDir({ "old.log": 15, "new.log": 13, "other.txt": 30 }, now);
		pruneJobLogs(dir, now);
		expect(existsSync(join(dir, "old.log"))).toBe(false);
		expect(existsSync(join(dir, "new.log"))).toBe(true);
		expect(existsSync(join(dir, "other.txt"))).toBe(true);
	});

	test("ignores a missing directory", () => {
		expect(() => pruneJobLogs(join(tmpdir(), "cr-no-such-dir"), now)).not.toThrow();
	});
});
