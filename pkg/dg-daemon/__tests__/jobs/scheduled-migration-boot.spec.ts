import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { readFileSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "../commands/job-cli-helpers";
import {
	allocatePort,
	readDaemonLog,
	spawnServe,
	stopServe,
	waitForHealth,
} from "../utils/daemon-harness";
import {
	type Booted,
	bootSeeded,
	configOf,
	FUTURE,
	openStoreAt,
	pathsOf,
	rawRun,
	rowInput,
	until,
	workDir,
} from "./scheduled-fixtures";

setDefaultTimeout(30_000);

const booted: Booted[] = [];
afterEach(async () => {
	for (const daemon of booted.splice(0)) await daemon.dispose();
});

async function boot(seed: Parameters<typeof bootSeeded>[0]) {
	const daemon = await bootSeeded(seed);
	booted.push(daemon);
	return daemon;
}

const moved = (dgHome: string, count: number) =>
	until(
		() => configOf(dgHome),
		(config) =>
			config.jobsVersion === 2 && Object.keys(config.jobs).length >= count,
		"moved the rows",
	);

describe("daemon start moves scheduled rows", () => {
	it("logs the old and new name of a renamed row and lists the new name with the old one", async () => {
		const { dgHome, port } = await boot({
			rows: [rowInput({ label: "Jira Sprint", cwd: workDir() })],
		});
		await moved(dgHome, 1);

		expect(readDaemonLog(dgHome)).toContain(
			'scheduled job "Jira Sprint" is now "jira-sprint"',
		);
		const list = await runCli(dgHome, ["job", "list"], { port });
		expect(list.stdout).toContain("jira-sprint");
		expect(list.stdout).toContain('was "Jira Sprint"');
		const json = await runCli(dgHome, ["job", "list", "--json"], { port });
		const rows = JSON.parse(json.stdout).jobs as Array<Record<string, unknown>>;
		expect(rows.find((row) => row.name === "jira-sprint")?.renamedFrom).toBe(
			"Jira Sprint",
		);
	});

	it("gives the mark 2 to a config with no services key and a store with no row", async () => {
		const { dgHome } = await boot({ jobsVersion: 0 });

		const config = await moved(dgHome, 0);

		expect(config.jobsVersion).toBe(2);
	});

	it("moves nothing and writes no file at a second daemon start", async () => {
		const first = await boot({
			rows: [rowInput({ label: "once", cwd: workDir() })],
		});
		await moved(first.dgHome, 1);
		await stopServe(first.proc);
		const file = pathsOf(first.dgHome).daemonConfigPath;
		const bytes = readFileSync(file, "utf8");
		const old = new Date("2020-01-01T00:00:00.000Z");
		utimesSync(file, old, old);

		const port = allocatePort();
		const proc = spawnServe(first.dgHome, port, {});
		try {
			await waitForHealth(port, 8000);
			await Bun.sleep(500);
		} finally {
			await stopServe(proc);
		}

		expect(readFileSync(file, "utf8")).toBe(bytes);
		expect(statSync(file).mtimeMs).toBe(old.getTime());
	});

	it("moves nothing and writes no entry at a restart after job add --every", async () => {
		const daemon = await boot({ jobsVersion: 2 });
		await waitForHealth(daemon.port, 8000);
		const added = await runCli(
			daemon.dgHome,
			[
				"job",
				"add",
				"--name",
				"added",
				"--every",
				"15m",
				"--cwd",
				workDir(),
				"--",
				"printf",
				"x",
			],
			{ port: daemon.port },
		);
		expect(added.code).toBe(0);
		await stopServe(daemon.proc);
		const file = pathsOf(daemon.dgHome).daemonConfigPath;
		const bytes = readFileSync(file, "utf8");
		const old = new Date("2020-01-01T00:00:00.000Z");
		utimesSync(file, old, old);

		const port = allocatePort();
		const proc = spawnServe(daemon.dgHome, port, {});
		try {
			await waitForHealth(port, 8000);
			await Bun.sleep(500);
		} finally {
			await stopServe(proc);
		}

		expect(readFileSync(file, "utf8")).toBe(bytes);
		expect(statSync(file).mtimeMs).toBe(old.getTime());
		const store = await openStoreAt(daemon.dgHome);
		try {
			expect(store.listJobs().filter((job) => job.label === "added")).toEqual(
				[],
			);
		} finally {
			store.close();
		}
	});

	it("refuses job add for the label of a row that the daemon moved", async () => {
		const { dgHome, port } = await boot({
			rows: [
				rowInput({
					label: "jira-sprint",
					argv: ["from", "the", "row"],
					cwd: workDir(),
				}),
			],
		});
		await moved(dgHome, 1);

		const result = await runCli(
			dgHome,
			[
				"job",
				"add",
				"--name",
				"jira-sprint",
				"--every",
				"1h",
				"--cwd",
				workDir(),
				"--",
				"from",
				"the",
				"cli",
			],
			{ port },
		);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("already exists");
		expect(configOf(dgHome).jobs["jira-sprint"].argv).toEqual([
			"from",
			"the",
			"row",
		]);
	});
});

describe("daemon start with a row that cannot move", () => {
	const gone = () => join(workDir(), "gone");
	it.each([
		["an argv that does not decrypt", {}, true],
		[
			"a cron text that is not valid",
			{ cronExpr: "not a cron", nextRunAt: FUTURE },
			false,
		],
		["a cwd that is gone", { cwd: gone() }, false],
		["an entry that fails parseJobEntry", { intervalMs: 0 }, false],
	] as const)(
		"keeps a row with %s, warns once, writes the mark 2 and lists it as invalid",
		async (_cause, overrides, corrupt) => {
			const label = "stuck";
		const { dgHome: home, port } = await boot({
			jobsVersion: 1,
			rows: [rowInput({ label, cwd: workDir(), ...overrides })],
			prepare: async (dgHome) => {
				if (!corrupt) return;
				const store = await openStoreAt(dgHome);
				try {
					rawRun(
						store,
						"UPDATE scheduled_jobs SET argv_tag = zeroblob(16) WHERE label = ?",
						label,
					);
				} finally {
					store.close();
				}
			},
		});
		await until(
			() => configOf(home),
			(config) => config.jobsVersion === 2,
			"wrote the mark 2",
		);

		const log = readDaemonLog(home);
			const warnings = log.split("\n").filter((line) => line.includes(label));
			expect(warnings).toHaveLength(1);
			const store = await openStoreAt(home);
			try {
				expect(store.getJobByLabel(label)).toBeDefined();
			} finally {
				store.close();
			}
			const list = await runCli(home, ["job", "list"], { port });
			const line = list.stdout
				.split("\n")
				.find((entry) => entry.startsWith(label));
			expect(line).toContain("invalid");
			const add = await runCli(
				home,
				[
					"job",
					"add",
					"--name",
					label,
					"--every",
					"1h",
					"--cwd",
					workDir(),
					"--",
					"x",
				],
				{ port },
			);
			expect(add.code).toBe(1);
			expect(add.stderr).toContain("already exists");
		},
	);
});
