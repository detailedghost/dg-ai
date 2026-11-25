import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parseJobEntry } from "../../src/jobs/config";
import { freshTempDir } from "../utils/daemon-harness";
import { configPathOf } from "../utils/service-daemon";
import {
	homeTracker,
	jobsTable,
	lines,
	readConfigFile,
	runCli,
	seedJobs,
	sleeperEntry,
} from "./job-cli-helpers";

const homes = homeTracker();
afterEach(() => homes.cleanup());

const CMD = [process.execPath, "-e", "1"];
const RULE =
	"must be 1-64 lowercase letters, digits or hyphens, starting with a letter or digit";

function preparedHome(jobs: Record<string, unknown> = {}) {
	const dgHome = homes.fresh();
	seedJobs(dgHome, jobs, { jobsVersion: 2 });
	return dgHome;
}

async function scheduledRow(dgHome: string, label: string) {
	return jobsTable(readConfigFile(dgHome))[label];
}

const addArgs = (dir: string, flags: string[], command: string[] = CMD) => [
	"job",
	"add",
	...flags,
	"--cwd",
	dir,
	"--",
	...command,
];

describe("job add --continuous", () => {
	it("writes the jobs entry and points to enable", async () => {
		const dgHome = preparedHome();
		const dir = freshTempDir("job-cwd");

		const result = await runCli(
			dgHome,
			addArgs(dir, ["--name", "x", "--continuous"]),
		);

		expect(result.code).toBe(0);
		expect(lines(result.stdout)).toEqual([
			'added job "x"',
			"next: dg job enable x",
		]);
		expect(jobsTable(readConfigFile(dgHome)).x).toEqual({
			argv: CMD,
			cwd: resolve(dir),
			continuous: true,
		});
	});

	it("writes passEnv for --env", async () => {
		const dir = freshTempDir("job-cwd");
		const home = preparedHome();

		const env = await runCli(
			home,
			addArgs(dir, ["--name", "x", "--continuous", "--env", "PATH"]),
		);

		expect(env.code).toBe(0);
		expect(jobsTable(readConfigFile(home)).x.passEnv).toEqual(["PATH"]);
	});

	it("writes each repeated passEnv name one time", async () => {
		const dir = freshTempDir("job-cwd");
		const repeated = preparedHome();

		const same = await runCli(
			repeated,
			addArgs(dir, ["--name", "x", "--continuous", "--env", "A", "--env", "A"]),
		);

		expect(same.code).toBe(0);
		expect(jobsTable(readConfigFile(repeated)).x.passEnv).toEqual(["A"]);
	});

	it("refuses --env with a value and writes nothing", async () => {
		const dgHome = preparedHome();
		const before = readFileSync(configPathOf(dgHome), "utf8");

		const result = await runCli(
			dgHome,
			addArgs(freshTempDir("job-cwd"), [
				"--name",
				"x",
				"--continuous",
				"--env",
				"A=b",
			]),
		);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			"job add: --env takes a variable name — put a value in the file of --env-file",
		);
		expect(readFileSync(configPathOf(dgHome), "utf8")).toBe(before);
	});

	it("keeps the env file, repeated --env names and the stop timeout", async () => {
		const dgHome = preparedHome();
		const dir = freshTempDir("job-cwd");

		const result = await runCli(
			dgHome,
			addArgs(dir, [
				"--name",
				"x",
				"--continuous",
				"--env-file",
				"secrets.env",
				"--env",
				"A",
				"--env",
				"B",
				"--stop-timeout",
				"30s",
			]),
			{ cwd: dir },
		);

		expect(result.code).toBe(0);
		const entry = jobsTable(readConfigFile(dgHome)).x;
		expect(entry.envFile).toBe(resolve(dir, "secrets.env"));
		expect(entry.passEnv).toEqual(["A", "B"]);
		expect(entry.stopTimeoutMs).toBe(30_000);
	});
});

describe("job add mode flags", () => {
	const modeError =
		"job add: give one of --continuous, --schedule or --every";

	it("refuses no mode flag, two mode flags and the continuous and every pair", async () => {
		const dir = freshTempDir("job-cwd");
		for (const flags of [
			["--name", "x"],
			["--name", "x", "--continuous", "--every", "15m"],
			["--name", "x", "--every", "15m", "--schedule", "0 9 * * *"],
		]) {
			const dgHome = preparedHome();
			const before = readFileSync(configPathOf(dgHome), "utf8");

			const result = await runCli(dgHome, addArgs(dir, flags));

			expect(result.code).toBe(1);
			expect(result.stderr).toContain(modeError);
			expect(readFileSync(configPathOf(dgHome), "utf8")).toBe(before);
		}
	});

	it("refuses an add that has no command after the bare --", async () => {
		const dgHome = preparedHome();

		const result = await runCli(dgHome, [
			"job",
			"add",
			"--name",
			"x",
			"--continuous",
			"--cwd",
			freshTempDir("job-cwd"),
		]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			"job add: no command given — put it after a bare --",
		);
	});

	it("prefixes a bad --cwd and an executable that does not resolve with job add:", async () => {
		const dgHome = preparedHome();

		const cwd = await runCli(
			dgHome,
			addArgs("/no/such/dir-for-job-add", ["--name", "x", "--continuous"]),
		);
		const exe = await runCli(
			dgHome,
			addArgs(freshTempDir("job-cwd"), ["--name", "x", "--continuous"], [
				"no-such-executable-for-job-add",
			]),
		);

		expect(cwd.code).toBe(1);
		expect(cwd.stderr).toContain("job add:");
		expect(cwd.stderr).toContain("no such directory");
		expect(exe.code).toBe(1);
		expect(exe.stderr).toContain("job add:");
		expect(exe.stderr).toContain("no-such-executable-for-job-add");
	});

	it("refuses each flag that does not fit its mode", async () => {
		const dir = freshTempDir("job-cwd");
		const cases: [string[], string][] = [
			[["--name", "x", "--every", "15m", "--stop-timeout", "5s"], "stopTimeoutMs"],
			[["--name", "x", "--continuous", "--timeout", "5m"], "timeoutMs"],
			[["--name", "x", "--continuous", "--feed"], "feed"],
			[["--name", "x", "--continuous", "--notify", "bob"], "notify"],
		];
		for (const [flags, key] of cases) {
			const dgHome = preparedHome();
			const before = readFileSync(configPathOf(dgHome), "utf8");

			const result = await runCli(dgHome, addArgs(dir, flags));

			expect(result.code).toBe(1);
			expect(result.stderr).toContain("job add:");
			expect(result.stderr).toContain(key);
			expect(readFileSync(configPathOf(dgHome), "utf8")).toBe(before);
			expect(await scheduledRow(dgHome, "x")).toBeUndefined();
		}
	});
});

describe("job add a scheduled job", () => {
	it("writes an entry with no enabled key for --name with --every", async () => {
		const dgHome = preparedHome();

		const result = await runCli(
			dgHome,
			addArgs(freshTempDir("job-cwd"), ["--name", "x", "--every", "15m"]),
		);

		expect(result.code).toBe(0);
		const entry = await scheduledRow(dgHome, "x");
		expect(entry?.every).toBe("15m");
		expect(Object.hasOwn(entry ?? {}, "enabled")).toBe(false);
		expect(lines(result.stdout)).toContain("next: dg job enable x");
	});

	it("takes --schedule as the cron mode flag", async () => {
		const dgHome = preparedHome();

		const result = await runCli(
			dgHome,
			addArgs(freshTempDir("job-cwd"), [
				"--name",
				"x",
				"--schedule",
				"0 9 * * 1-5",
			]),
		);

		expect(result.code).toBe(0);
		expect((await scheduledRow(dgHome, "x"))?.schedule).toBe("0 9 * * 1-5");
	});

	it("stores --feed and --timeout in the entry and prints no note", async () => {
		const dgHome = preparedHome();

		const result = await runCli(
			dgHome,
			addArgs(freshTempDir("job-cwd"), [
				"--name",
				"x",
				"--every",
				"15m",
				"--feed",
				"--timeout",
				"5m",
			]),
		);

		expect(result.code).toBe(0);
		expect(result.stderr).not.toContain("take effect after the jobs move");
		const entry = await scheduledRow(dgHome, "x");
		expect(entry?.feed).toBe(true);
		expect(entry?.timeoutMs).toBe(5 * 60_000);
	});
});

describe("job add on a name the table holds", () => {
	it("refuses a repeat add of a scheduled name with no note", async () => {
		const dgHome = preparedHome();
		const dir = freshTempDir("job-cwd");
		await runCli(dgHome, addArgs(dir, ["--name", "x", "--every", "15m"]));

		const result = await runCli(
			dgHome,
			addArgs(dir, ["--name", "x", "--every", "15m", "--feed"]),
		);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('a job named "x" already exists');
		expect(result.stderr).not.toContain("take effect after the jobs move");
	});
});

describe("job add name rules", () => {
	it("refuses a bad --name, names the flag and writes nothing", async () => {
		const dir = freshTempDir("job-cwd");
		const cases: [string[], string][] = [
			[["--name", "Bad Name", "--every", "15m"], "--name"],
			[["--name", "Bad_Name", "--continuous"], "--name"],
		];
		for (const [flags, flag] of cases) {
			const dgHome = preparedHome();
			const before = readFileSync(configPathOf(dgHome), "utf8");

			const result = await runCli(dgHome, addArgs(dir, flags));

			expect(result.code).toBe(1);
			expect(result.stderr).toContain(`job add: "${flag}" ${RULE}`);
			expect(readFileSync(configPathOf(dgHome), "utf8")).toBe(before);
			expect(await scheduledRow(dgHome, flags[1])).toBeUndefined();
		}
	});

	it("uses the rule text of the entry parser", () => {
		const parsed = parseJobEntry("Bad Label", {});

		expect(parsed.ok).toBe(false);
		expect(parsed.ok === false && parsed.error).toBe(`label ${RULE}`);
	});

	it("refuses a name that the jobs table holds", async () => {
		const dir = freshTempDir("job-cwd");
		const dgHome = preparedHome({ x: sleeperEntry(dir) });

		const result = await runCli(
			dgHome,
			addArgs(dir, ["--name", "x", "--every", "15m"]),
		);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('a job named "x" already exists');
		expect((await scheduledRow(dgHome, "x"))?.continuous).toBe(true);
	});

	it("refuses a name that a scheduled row holds", async () => {
		const dir = freshTempDir("job-cwd");
		const dgHome = preparedHome();
		const first = await runCli(
			dgHome,
			addArgs(dir, ["--name", "y", "--every", "15m"]),
		);
		expect(first.code).toBe(0);
		const before = readFileSync(configPathOf(dgHome), "utf8");

		const result = await runCli(
			dgHome,
			addArgs(dir, ["--name", "y", "--continuous"]),
		);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('a job named "y" already exists');
		expect(readFileSync(configPathOf(dgHome), "utf8")).toBe(before);
	});

	it.each([["--env", "PATH", "passEnv", ["PATH"]]])("stores %s of a scheduled add in the table entry", async (flag, value, key, stored) => {
		const dir = freshTempDir("job-cwd");
		const dgHome = preparedHome();

		const result = await runCli(
			dgHome,
			addArgs(dir, ["--name", "s1", "--every", "15m", flag, value]),
		);

		expect(result.code).toBe(0);
		expect((await scheduledRow(dgHome, "s1"))?.[key]).toEqual(stored);
	});

	it("stores an absolute --env-file path on a scheduled add", async () => {
		const dir = freshTempDir("job-cwd");
		const dgHome = preparedHome();

		const result = await runCli(
			dgHome,
			addArgs(dir, ["--name", "s1", "--every", "15m", "--env-file", "e.env"]),
		);

		expect(result.code).toBe(0);
		const stored = (await scheduledRow(dgHome, "s1"))?.envFile;
		expect(typeof stored === "string" && isAbsolute(stored)).toBe(true);
		expect(String(stored).endsWith("e.env")).toBe(true);
	});

	it("accepts --notify with --feed on a scheduled add with the new form", async () => {
		const dir = freshTempDir("job-cwd");
		const dgHome = preparedHome();

		const result = await runCli(
			dgHome,
			addArgs(dir, ["--name", "n1", "--every", "15m", "--feed", "--notify", "bob"]),
		);

		expect(result.code).toBe(0);
		expect((await scheduledRow(dgHome, "n1"))?.notify).toBe("bob");
	});

	it.each([
		["--every", "15m"],
		["--schedule", "0 9 * * 1-5"],
	])("refuses --notify without --feed on the new form with %s", async (mode, value) => {
		const dir = freshTempDir("job-cwd");
		const dgHome = preparedHome();
		const before = readFileSync(configPathOf(dgHome), "utf8");
		const probe = parseJobEntry("n2", {
			argv: CMD,
			cwd: dir,
			[mode === "--every" ? "every" : "schedule"]: value,
			notify: "bob",
		});

		const result = await runCli(
			dgHome,
			addArgs(dir, ["--name", "n2", mode, value, "--notify", "bob"]),
		);

		expect(probe.ok).toBe(false);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			`job add: ${probe.ok === false ? probe.error : ""}`,
		);
		expect(readFileSync(configPathOf(dgHome), "utf8")).toBe(before);
	});

	it("checks the --env value before the need for --continuous", async () => {
		const dir = freshTempDir("job-cwd");
		const dgHome = preparedHome();

		const result = await runCli(
			dgHome,
			addArgs(dir, ["--name", "s2", "--every", "15m", "--env", "A=b"]),
		);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			"job add: --env takes a variable name — put a value in the file of --env-file",
		);
	});
});
