import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { join } from "node:path";
import {
	type Booted,
	bootSeeded,
	configOf,
	jobByLabel,
	lineCount,
	openStoreAt,
	scriptArgv,
	seedHome,
	tableEntry,
	until,
	workDir,
} from "../jobs/scheduled-fixtures";
import { lines } from "./job-cli-helpers";
import { runCli } from "./service-cli-helpers";

setDefaultTimeout(30_000);

const booted: Booted[] = [];
afterEach(async () => {
	for (const daemon of booted.splice(0)) await daemon.dispose();
});

async function boot(jobs: Record<string, unknown>) {
	const daemon = await bootSeeded({ jobsVersion: 2, jobs });
	booted.push(daemon);
	return daemon;
}

const startedAt = (counter: string, script = "") =>
	scriptArgv(
		`require("node:fs").appendFileSync(${JSON.stringify(counter)},"start\\n");${script}`,
	);

describe("job start of a scheduled job", () => {
	it("runs it one time, prints one status line and keeps the next scheduled time", async () => {
		const cwd = workDir();
		const counter = join(cwd, "count");
		const { dgHome, port } = await boot({
			x: tableEntry(cwd, startedAt(counter)),
		});
		await until(
			() => lineCount(counter),
			(count) => count >= 1,
			"ran the first run",
		);
		const before = (
			await until(
				() => jobByLabel(dgHome, "x"),
				(job) => job?.lastExitCode !== undefined,
				"recorded the first run",
			)
		)?.nextRunAt;

		const result = await runCli(dgHome, ["job", "start", "x"], { port });

		expect(result.code).toBe(0);
		expect(lines(result.stdout)).toHaveLength(1);
		expect(result.stdout).toContain("x");
		expect(result.stdout).toContain("running");
		await until(
			() => lineCount(counter),
			(count) => count >= 2,
			"ran the manual run",
		);
		await Bun.sleep(400);
		expect(lineCount(counter)).toBe(2);
		expect((await jobByLabel(dgHome, "x"))?.nextRunAt).toBe(before);
	});

	it("exits 1 with already runs for a second start during the run", async () => {
		const cwd = workDir();
		const counter = join(cwd, "count");
		const { dgHome, port } = await boot({
			x: tableEntry(
				cwd,
				startedAt(counter, "setTimeout(()=>{},5000)"),
			),
		});
		await until(
			() => lineCount(counter),
			(count) => count >= 1,
			"began the run",
		);

		const result = await runCli(dgHome, ["job", "start", "x"], { port });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('job "x" already runs');
	});

	it("exits 1 with no live dg-daemon when no daemon answers", async () => {
		const { dgHome } = await seedHome({
			jobsVersion: 2,
			jobs: { x: tableEntry(workDir(), ["printf", ""]) },
		});

		const result = await runCli(dgHome, ["job", "start", "x"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("no live dg-daemon");
	});
});

describe("scheduled job verbs on the table", () => {
	it("lists continuous and scheduled jobs in one list", async () => {
		const cwd = workDir();
		const { dgHome, port } = await boot({
			sleeper: {
				continuous: true,
				argv: scriptArgv("setTimeout(()=>{},600000)"),
				cwd,
			},
			ticker: tableEntry(cwd, ["printf", ""], { every: "15m" }),
		});

		const result = await runCli(dgHome, ["job", "list"], { port });

		expect(result.stdout).toContain("sleeper");
		expect(result.stdout).toContain("ticker");
	});

	it("shows the output of a scheduled run through job logs", async () => {
		const cwd = workDir();
		const { dgHome, port } = await boot({
			talker: tableEntry(cwd, ["printf", "hello from the run\n"]),
		});
		await until(
			() => jobByLabel(dgHome, "talker"),
			(job) => job?.lastExitCode !== undefined,
			"ran talker",
		);

		const result = await runCli(dgHome, ["job", "logs", "talker"], { port });

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("hello from the run");
	});

	it("prints the next run time at enable and sets enabled in the table", async () => {
		const cwd = workDir();
		const { dgHome, port } = await boot({
			x: { every: "15m", argv: ["printf", ""], cwd },
		});

		const result = await runCli(dgHome, ["job", "enable", "x"], { port });

		expect(result.code).toBe(0);
		expect(result.stdout).toMatch(/\d{4}-\d{2}-\d{2}/);
		expect(configOf(dgHome).jobs.x.enabled).toBe(true);
	});

	it("sets enabled false at disable", async () => {
		const cwd = workDir();
		const { dgHome, port } = await boot({
			x: tableEntry(cwd, ["printf", ""]),
		});

		const result = await runCli(dgHome, ["job", "disable", "x"], { port });

		expect(result.code).toBe(0);
		expect(configOf(dgHome).jobs.x.enabled).toBe(false);
	});

	it("removes the entry, the state row and the feed items at rm", async () => {
		const cwd = workDir();
		const { dgHome, port } = await boot({
			x: tableEntry(
				cwd,
				scriptArgv('console.log(JSON.stringify({id:"a",title:"A"}))'),
				{ feed: true },
			),
		});
		await until(
			() => jobByLabel(dgHome, "x"),
			(job) => job?.lastExitCode === 0,
			"ran x",
		);

		const result = await runCli(dgHome, ["job", "rm", "x"], { port });

		expect(result.code).toBe(0);
		expect(Object.keys(configOf(dgHome).jobs)).toEqual([]);
		const store = await openStoreAt(dgHome);
		try {
			expect(store.getJobByLabel("x")).toBeUndefined();
			expect(store.listFeedItems()).toHaveLength(0);
		} finally {
			store.close();
		}
	});
});
