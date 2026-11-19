import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import {
	allocatePort,
	freshTempDir,
	killDaemonByPidFile,
	spawnServe,
	stopServe,
	waitForDaemonExit,
	waitForHealth,
} from "../utils/daemon-harness";
import { configPathOf, writeConfigFile } from "../utils/service-daemon";
import {
	fetchJobRows,
	homeTracker,
	jobsTable,
	lines,
	pathsOf,
	postJob,
	readConfigFile,
	runCli,
	SLEEPER_ARGV,
	seedJobs,
	sleeperEntry,
	waitUntil,
} from "./job-cli-helpers";

const homes = homeTracker();
const procs: ReturnType<typeof spawnServe>[] = [];
afterEach(async () => {
	for (const proc of procs.splice(0)) await stopServe(proc).catch(() => {});
	await homes.cleanup();
});

const isAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

async function bootAgain(dgHome: string) {
	const port = allocatePort();
	const proc = spawnServe(dgHome, port);
	procs.push(proc);
	await waitForHealth(port, 8000);
	return port;
}

describe("daemon boot after enable and disable", () => {
	it("starts the job at boot with no job start call after enable", async () => {
		const { dgHome, port, proc } = await homes.boot((cwd) => ({
			x: sleeperEntry(cwd),
		}));
		const enable = await runCli(dgHome, ["job", "enable", "x"], { port });
		expect(enable.code).toBe(0);
		await stopServe(proc);
		await waitForDaemonExit(dgHome).catch(() => {});

		const next = await bootAgain(dgHome);

		await waitUntil(async () => (await fetchJobRows(dgHome, next))[0]?.state === "running");
	});

	it("leaves the job stopped at boot after disable", async () => {
		const dgHome = homes.fresh();
		seedJobs(dgHome, {
			x: sleeperEntry(freshTempDir("job-cwd"), { enabled: true }),
		});
		const disable = await runCli(dgHome, ["job", "disable", "x"]);
		expect(disable.code).toBe(0);

		const port = await bootAgain(dgHome);

		await Bun.sleep(1500);
		expect((await fetchJobRows(dgHome, port))[0].state).toBe("stopped");
	});

	it("starts an enabled job at boot (control for the disable case)", async () => {
		const dgHome = homes.fresh();
		seedJobs(dgHome, {
			x: sleeperEntry(freshTempDir("job-cwd"), { enabled: true }),
		});

		const port = await bootAgain(dgHome);

		await waitUntil(async () => (await fetchJobRows(dgHome, port))[0]?.state === "running");
	});
});

describe("job restart of a running job", () => {
	it("runs with a new pid, and enabled is as it was", async () => {
		const { dgHome, port } = await homes.boot((cwd) => ({
			x: sleeperEntry(cwd, { enabled: true }),
		}));
		expect((await postJob(port, "x", "start")).ok).toBe(true);
		const pidBefore = (await fetchJobRows(dgHome, port))[0].pid as number;
		const configBefore = readFileSync(configPathOf(dgHome), "utf8");

		const result = await runCli(dgHome, ["job", "restart", "x"], { port });

		expect(result.code).toBe(0);
		const status = lines(result.stdout).at(-1) ?? "";
		const pidAfter = Number(/pid (\d+)/.exec(status)?.[1]);
		expect(status).toMatch(/^x +running/);
		expect(pidAfter).not.toBe(pidBefore);
		await waitUntil(() => !isAlive(pidBefore));
		expect((await fetchJobRows(dgHome, port))[0].pid).toBe(pidAfter);
		expect(readFileSync(configPathOf(dgHome), "utf8")).toBe(configBefore);
	});
});

describe("a config with no jobsVersion", () => {
	const legacy = (dgHome: string) =>
		writeConfigFile(dgHome, {
			pinnedOrigin: "p",
			services: { x: { argv: SLEEPER_ARGV, cwd: dgHome } },
		});

	type Table = ReturnType<typeof jobsTable>;
	const cases: [string, (cwd: string) => string[], (table: Table) => void][] = [
		[
			"add",
			(cwd) => [
				"job",
				"add",
				"--name",
				"y",
				"--continuous",
				"--cwd",
				cwd,
				"--",
				process.execPath,
				"-e",
				"1",
			],
			(table) => {
				expect(table.x).toBeDefined();
				expect(table.y).toBeDefined();
			},
		],
		[
			"enable",
			() => ["job", "enable", "x"],
			(table) => expect(table.x).toBeDefined(),
		],
		[
			"disable",
			() => ["job", "disable", "x"],
			(table) => expect(table.x).toBeDefined(),
		],
		[
			"update",
			() => ["job", "update", "x", "--every", "30m"],
			(table) => expect(table.x).toBeDefined(),
		],
		[
			"remove",
			() => ["job", "remove", "x"],
			(table) => expect(table.x).toBeUndefined(),
		],
	];

	for (const [verb, args, expectTable] of cases) {
		it(`${verb} starts the daemon one time, waits for the mark, then continues`, async () => {
			const dgHome = homes.fresh();
			legacy(dgHome);
			expect(existsSync(pathsOf(dgHome).pidPath)).toBe(false);

			const result = await runCli(dgHome, args(dgHome));

			expect(result.code).toBe(0);
			expect(existsSync(pathsOf(dgHome).pidPath)).toBe(true);
			const config = readConfigFile(dgHome) as Record<string, unknown>;
			expect(config.jobsVersion).toBe(2);
			expectTable(jobsTable(config));
			killDaemonByPidFile(dgHome);
		});
	}
});
