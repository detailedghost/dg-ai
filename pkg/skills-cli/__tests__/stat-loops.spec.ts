import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findStalled, type JobView, lastLogLine } from "../src/stat/loops";

const NOW = Date.parse("2026-11-13T12:00:00Z");
const MIN = 60_000;

function job(id: string, extra: Partial<JobView> = {}): JobView {
	return {
		id,
		state: "running",
		cwd: "/repo",
		startedAt: new Date(NOW - 30 * MIN).toISOString(),
		logFile: `/logs/${id}.log`,
		...extra,
	};
}

function stalled(jobs: JobView[], mtimes: Record<string, number | null>) {
	return findStalled(jobs, {
		cwd: "/repo",
		now: NOW,
		stallMinutes: 20,
		maxAgeMinutes: 180,
		logMtime: (file) => mtimes[file] ?? null,
		lastLine: (file) => `last of ${file}`,
	});
}

describe("stat loops", () => {
	test("flags a running job whose log has not grown for the stall time", () => {
		const out = stalled([job("a"), job("b")], {
			"/logs/a.log": NOW - 25 * MIN,
			"/logs/b.log": NOW - 2 * MIN,
		});
		expect(out).toEqual([
			{
				id: "a",
				reason: "no log growth",
				idleMinutes: 25,
				ageMinutes: 30,
				logFile: "/logs/a.log",
				lastLine: "last of /logs/a.log",
			},
		]);
	});

	test("flags a job past the max age even when its log grows", () => {
		const out = stalled([job("a", { startedAt: new Date(NOW - 200 * MIN).toISOString() })], {
			"/logs/a.log": NOW,
		});
		expect(out.map((j) => [j.id, j.reason])).toEqual([["a", "past max age"]]);
	});

	test("ignores finished jobs and jobs outside the cwd", () => {
		const old = NOW - 60 * MIN;
		const out = stalled(
			[job("done", { state: "done" }), job("sib", { cwd: "/repo-other" }), job("sub", { cwd: "/repo/pkg" })],
			{ "/logs/done.log": old, "/logs/sib.log": old, "/logs/sub.log": old },
		);
		expect(out.map((j) => j.id)).toEqual(["sub"]);
	});

	test("a missing log counts from the job start", () => {
		expect(stalled([job("a")], {}).map((j) => j.idleMinutes)).toEqual([30]);
	});

	test("lastLogLine returns the last non-empty line without color codes", () => {
		const dir = mkdtempSync(join(tmpdir(), "dg-stat-loops-"));
		try {
			const file = join(dir, "x.log");
			writeFileSync(file, "one\n\u001b[31mwaiting for checks\u001b[0m\n\n");
			expect(lastLogLine(file)).toBe("waiting for checks");
			expect(lastLogLine(join(dir, "missing.log"))).toBe("");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
