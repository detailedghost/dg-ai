import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { credentialGrantTokenPath, jobStateDir } from "@dg/common/node";
import { freshTempDir } from "../utils/daemon-harness";
import {
	fetchJobRows,
	homeTracker,
	lines,
	logFileOf,
	pathsOf,
	postJob,
	runCli,
	seedJobs,
	sleeperEntry,
	startFakeDaemon,
} from "./job-cli-helpers";

const homes = homeTracker();
const stoppers: (() => void)[] = [];
afterEach(async () => {
	for (const stop of stoppers.splice(0)) stop();
	await homes.cleanup();
});

const CONTINUOUS_KEYS = [
	"name",
	"mode",
	"enabled",
	"state",
	"pid",
	"restarts",
	"logFile",
	"stateDir",
	"cwd",
	"daemonUrl",
	"grantFile",
].sort();
const SCHEDULED_KEYS = [
	"name",
	"mode",
	"enabled",
	"schedule",
	"lastRunAt",
	"nextRunAt",
	"renamedFrom",
];

type Row = Record<string, unknown>;
const rowsOf = (stdout: string): Row[] => JSON.parse(stdout).jobs;

describe("job list --json", () => {
	it("prints one line with the eleven keys of a continuous job on a live daemon", async () => {
		const { dgHome, port } = await homes.boot((cwd) => ({
			x: sleeperEntry(cwd, { enabled: true, grant: "acme" }),
		}));
		const paths = pathsOf(dgHome);
		const grantFile = credentialGrantTokenPath(paths, "acme");
		mkdirSync(dirname(grantFile), { recursive: true });
		writeFileSync(grantFile, "token", { mode: 0o600 });
		expect((await postJob(port, "x", "start")).ok).toBe(true);
		const [live] = await fetchJobRows(dgHome, port);

		const result = await runCli(dgHome, ["job", "list", "--json"], { port });

		expect(result.code).toBe(0);
		expect(lines(result.stdout)).toHaveLength(1);
		const [row] = rowsOf(result.stdout);
		expect(Object.keys(row).sort()).toEqual(CONTINUOUS_KEYS);
		expect(row).toMatchObject({
			name: "x",
			mode: "continuous",
			enabled: true,
			state: "running",
			pid: live.pid,
			restarts: live.restarts,
			logFile: logFileOf(dgHome, "x"),
			stateDir: jobStateDir(paths, "x"),
			daemonUrl: `http://127.0.0.1:${port}`,
			grantFile: credentialGrantTokenPath(paths, "acme"),
		});
		expect(row.cwd).toBe(dgHome);
	});

	it("gives a null grantFile when the entry has no grant, and enabled false when the key is absent", async () => {
		const { dgHome, port } = await homes.boot((cwd) => ({
			x: sleeperEntry(cwd),
		}));

		const result = await runCli(dgHome, ["job", "list", "--json"], { port });

		const [row] = rowsOf(result.stdout);
		expect(row.grantFile).toBeNull();
		expect(row.enabled).toBe(false);
		expect(row.state).toBe("stopped");
	});

	it("reports daemon not running with a null pid, 0 restarts and a null daemonUrl", async () => {
		const dgHome = homes.fresh();
		seedJobs(dgHome, { x: sleeperEntry(freshTempDir("job-cwd")) });

		const result = await runCli(dgHome, ["job", "list", "--json"]);

		expect(result.code).toBe(0);
		const [row] = rowsOf(result.stdout);
		expect(Object.keys(row).sort()).toEqual(CONTINUOUS_KEYS);
		expect(row).toMatchObject({
			name: "x",
			state: "daemon not running",
			pid: null,
			restarts: 0,
			daemonUrl: null,
			logFile: logFileOf(dgHome, "x"),
			stateDir: jobStateDir(pathsOf(dgHome), "x"),
		});
	});

	it("lists the table rows, then each scheduled row, with the scheduled keys", async () => {
		const dgHome = homes.fresh();
		const cwd = freshTempDir("job-cwd");
		seedJobs(dgHome, { x: sleeperEntry(cwd) });
		const add = await runCli(dgHome, [
			"job",
			"add",
			"--label",
			"nightly",
			"--cron",
			"0 9 * * 1-5",
			"--cwd",
			cwd,
			"--",
			"printf",
			"",
		]);
		expect(add.code).toBe(0);

		const result = await runCli(dgHome, ["job", "list", "--json"]);

		const rows = rowsOf(result.stdout);
		expect(rows.map((row) => row.name)).toEqual(["x", "nightly"]);
		const scheduled = rows[1];
		for (const key of Object.keys(scheduled)) {
			expect(SCHEDULED_KEYS).toContain(key);
		}
		for (const key of SCHEDULED_KEYS) {
			expect(scheduled).toHaveProperty(key);
		}
		expect(scheduled).toMatchObject({
			name: "nightly",
			mode: "schedule",
			enabled: true,
			schedule: "0 9 * * 1-5",
		});
	});

	it("gives the mode every and the duration text for an interval row", async () => {
		const dgHome = homes.fresh();
		seedJobs(dgHome, {});
		await runCli(dgHome, [
			"job",
			"add",
			"--label",
			"poll",
			"--every",
			"15m",
			"--cwd",
			freshTempDir("job-cwd"),
			"--",
			"printf",
			"",
		]);

		const result = await runCli(dgHome, ["job", "list", "--json"]);

		expect(rowsOf(result.stdout)[0]).toMatchObject({
			name: "poll",
			mode: "every",
			schedule: "15m",
		});
	});
});

describe("job list", () => {
	it("exits 0 with a hint when no job exists", async () => {
		const dgHome = homes.fresh();
		seedJobs(dgHome, {});

		const result = await runCli(dgHome, ["job", "list"]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("job add");
	});

	it("shows the run state of each job on a live daemon", async () => {
		const { dgHome, port } = await homes.boot((cwd) => ({
			x: sleeperEntry(cwd),
		}));

		const result = await runCli(dgHome, ["job", "list"], { port });

		expect(result.code).toBe(0);
		expect(lines(result.stdout).some((line) => /^x\b.*\bstopped\b/.test(line))).toBe(true);
	});
});

describe("job status", () => {
	it("exits 1 for an unknown name", async () => {
		const dgHome = homes.fresh();
		seedJobs(dgHome, { x: sleeperEntry(freshTempDir("job-cwd")) });

		const result = await runCli(dgHome, ["job", "status", "ghost"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('no job named "ghost"');
	});

	it("prints one row for one name as {\"jobs\":[row]}", async () => {
		const cwd = freshTempDir("job-cwd");
		const dgHome = homes.fresh();
		seedJobs(dgHome, { x: sleeperEntry(cwd), y: sleeperEntry(cwd) });

		const result = await runCli(dgHome, ["job", "status", "y", "--json"]);

		expect(result.code).toBe(0);
		const parsed = JSON.parse(result.stdout);
		expect(Object.keys(parsed)).toEqual(["jobs"]);
		expect(parsed.jobs).toHaveLength(1);
		expect(parsed.jobs[0].name).toBe("y");
	});

	it("prints every job when no name is given", async () => {
		const cwd = freshTempDir("job-cwd");
		const dgHome = homes.fresh();
		seedJobs(dgHome, { x: sleeperEntry(cwd), y: sleeperEntry(cwd) });

		const result = await runCli(dgHome, ["job", "status", "--json"]);

		expect(rowsOf(result.stdout).map((row) => row.name).sort()).toEqual(["x", "y"]);
	});
});

describe("job list and status against an old daemon", () => {
	it.each([
		["list", ["job", "list"]],
		["list --json", ["job", "list", "--json"]],
		["status", ["job", "status", "x"]],
		["status --json", ["job", "status", "x", "--json"]],
	])("%s exits 1 with the older-than-the-CLI text on a 404 of GET /jobs", async (_label, args) => {
		const dgHome = homes.fresh();
		seedJobs(dgHome, { x: sleeperEntry(freshTempDir("job-cwd")) });
		const fake = startFakeDaemon(
			dgHome,
			() => new Response("not found", { status: 404 }),
		);
		stoppers.push(fake.stop);

		const result = await runCli(dgHome, args);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			"this dg-daemon is older than the CLI — run dg daemon restart",
		);
	});
});
