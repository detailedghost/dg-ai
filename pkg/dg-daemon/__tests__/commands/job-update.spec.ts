import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { parseJobEntry } from "../../src/jobs/config";
import { freshTempDir } from "../utils/daemon-harness";
import { configPathOf } from "../utils/service-daemon";
import {
	homeTracker,
	jobsTable,
	lines,
	postJob,
	readConfigFile,
	runCli,
	seedJobs,
	sleeperEntry,
	startFakeDaemon,
} from "./job-cli-helpers";

const homes = homeTracker();
afterEach(() => homes.cleanup());

const CMD = [process.execPath, "-e", "1"];

function seeded(entry: (cwd: string) => Record<string, unknown>) {
	const dgHome = homes.fresh();
	const cwd = freshTempDir("job-cwd");
	seedJobs(dgHome, { x: entry(cwd) });
	return { dgHome, cwd };
}

describe("job update", () => {
	it("writes the new every, keeps enabled and reports the change", async () => {
		const { dgHome } = seeded((cwd) => ({
			every: "15m",
			argv: CMD,
			cwd,
			enabled: true,
		}));

		const result = await runCli(dgHome, ["job", "update", "x", "--every", "30m"]);

		expect(result.code).toBe(0);
		expect(lines(result.stdout)).toContain('updated job "x"');
		expect(lines(result.stdout).some((line) => line.includes("changed every"))).toBe(true);
		const entry = jobsTable(readConfigFile(dgHome)).x;
		expect(entry.every).toBe("30m");
		expect(entry.enabled).toBe(true);
		expect(entry.argv).toEqual(CMD);
	});

	it("replaces the mode key, so the entry has exactly one mode key", async () => {
		const { dgHome } = seeded((cwd) => ({
			schedule: "0 9 * * *",
			argv: CMD,
			cwd,
		}));

		const result = await runCli(dgHome, ["job", "update", "x", "--continuous"]);

		expect(result.code).toBe(0);
		const entry = jobsTable(readConfigFile(dgHome)).x;
		const modeKeys = ["continuous", "schedule", "every"].filter((key) =>
			Object.hasOwn(entry, key),
		);
		expect(modeKeys).toEqual(["continuous"]);
	});

	it("writes feed, notify and timeout together for a scheduled job", async () => {
		const { dgHome } = seeded((cwd) => ({ every: "15m", argv: CMD, cwd }));

		const result = await runCli(dgHome, [
			"job",
			"update",
			"x",
			"--feed",
			"--notify",
			"bob",
			"--timeout",
			"5m",
		]);

		expect(result.code).toBe(0);
		const entry = jobsTable(readConfigFile(dgHome)).x;
		expect(entry.feed).toBe(true);
		expect(entry.notify).toBe("bob");
		expect(entry.timeoutMs).toBe(5 * 60_000);
	});

	it("refuses a call with no flag", async () => {
		const { dgHome } = seeded((cwd) => ({ every: "15m", argv: CMD, cwd }));
		const before = readFileSync(configPathOf(dgHome), "utf8");

		const result = await runCli(dgHome, ["job", "update", "x"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("job update: give a flag to change");
		expect(readFileSync(configPathOf(dgHome), "utf8")).toBe(before);
	});

	it("refuses --continuous on an entry that holds feed, notify or timeoutMs, and writes nothing", async () => {
		const extras: Record<string, unknown>[] = [
			{ feed: true },
			{ feed: true, notify: "bob" },
			{ timeoutMs: 1000 },
		];
		for (const extra of extras) {
			const { dgHome, cwd } = seeded((dir) => ({
				every: "15m",
				argv: CMD,
				cwd: dir,
				...extra,
			}));
			const before = readFileSync(configPathOf(dgHome), "utf8");
			const merged = { continuous: true, argv: CMD, cwd, ...extra };
			const parsed = parseJobEntry("x", merged);
			expect(parsed.ok).toBe(false);

			const result = await runCli(dgHome, ["job", "update", "x", "--continuous"]);

			expect(result.code).toBe(1);
			expect(result.stderr).toContain(
				`job update: ${parsed.ok === false ? parsed.error : ""}`,
			);
			expect(readFileSync(configPathOf(dgHome), "utf8")).toBe(before);
		}
	});

	it("refuses --notify on an entry with no feed and writes nothing", async () => {
		const { dgHome, cwd } = seeded((dir) => ({ every: "15m", argv: CMD, cwd: dir }));
		const before = readFileSync(configPathOf(dgHome), "utf8");
		const parsed = parseJobEntry("x", { every: "15m", argv: CMD, cwd, notify: "y" });
		expect(parsed.ok).toBe(false);

		const result = await runCli(dgHome, ["job", "update", "x", "--notify", "y"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			`job update: ${parsed.ok === false ? parsed.error : ""}`,
		);
		expect(readFileSync(configPathOf(dgHome), "utf8")).toBe(before);
	});

	it("prints the restart hint when the job runs", async () => {
		const { dgHome, port } = await homes.boot((cwd) => ({
			x: sleeperEntry(cwd),
		}));
		expect((await postJob(port, "x", "start")).ok).toBe(true);

		const result = await runCli(
			dgHome,
			["job", "update", "x", "--every", "30m"],
			{ port },
		);

		expect(result.code).toBe(0);
		expect(lines(result.stdout)).toContain("next: dg job restart x");
	});

	it("prints no restart hint when the job is stopped", async () => {
		const { dgHome, port } = await homes.boot((cwd) => ({
			x: sleeperEntry(cwd),
		}));

		const result = await runCli(
			dgHome,
			["job", "update", "x", "--every", "30m"],
			{ port },
		);

		expect(result.code).toBe(0);
		expect(result.stdout).not.toContain("next: dg job restart");
	});

	it("names an unknown job, exits 1 and writes nothing", async () => {
		const { dgHome } = seeded((cwd) => ({ every: "15m", argv: CMD, cwd }));
		const before = readFileSync(configPathOf(dgHome), "utf8");

		const result = await runCli(dgHome, ["job", "update", "ghost", "--every", "30m"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('no job named "ghost"');
		expect(readFileSync(configPathOf(dgHome), "utf8")).toBe(before);
	});

	it("exits 0 and keeps the change when the daemon cannot list its jobs", async () => {
		const { dgHome } = seeded((cwd) => ({ every: "15m", argv: CMD, cwd }));
		const fake = startFakeDaemon(
			dgHome,
			() => new Response("not found", { status: 404 }),
		);

		try {
			const result = await runCli(dgHome, ["job", "update", "x", "--every", "30m"]);

			expect(result.code).toBe(0);
			expect(jobsTable(readConfigFile(dgHome)).x.every).toBe("30m");
			expect(result.stdout).not.toContain("next: dg job restart");
		} finally {
			fake.stop();
		}
	});
});
