import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { jobLogFile } from "../../src/jobs/launcher";
import { readDaemonLog } from "../utils/daemon-harness";
import {
	appendLineArgv,
	type Booted,
	bootSeeded,
	configOf,
	jobByLabel,
	lineCount,
	openStoreAt,
	pathsOf,
	QUARTER_HOUR_MS,
	rowInput,
	scriptArgv,
	tableEntry,
	until,
	workDir,
} from "./scheduled-fixtures";

setDefaultTimeout(30_000);

const booted: Booted[] = [];
afterEach(async () => {
	for (const daemon of booted.splice(0)) await daemon.dispose();
});

async function boot(seed: Parameters<typeof bootSeeded>[0]) {
	const daemon = await bootSeeded({ jobsVersion: 2, ...seed });
	booted.push(daemon);
	return daemon;
}

const logOf = (dgHome: string, name: string): string => {
	try {
		return readFileSync(jobLogFile(pathsOf(dgHome).logDir, name), "utf8");
	} catch {
		return "";
	}
};

const ranOnce = (dgHome: string, name: string) =>
	until(
		() => jobByLabel(dgHome, name),
		(job) => job?.lastExitCode !== undefined,
		`ran ${name}`,
	);

describe("scheduled run result", () => {
	it("gives the result ok and a log holding the text for no feed and text that is not JSON", async () => {
		const cwd = workDir();
		const { dgHome } = await boot({
			jobs: {
				plain: tableEntry(cwd, ["printf", "not json at all\n"]),
			},
		});

		const job = await ranOnce(dgHome, "plain");

		expect(job?.lastExitCode).toBe(0);
		expect(job?.lastError).toBeUndefined();
		expect(logOf(dgHome, "plain")).toContain("not json at all");
	});

	it("gives the error line 1: not valid JSON for feed true and text that is not JSON", async () => {
		const cwd = workDir();
		const { dgHome } = await boot({
			jobs: {
				fed: tableEntry(cwd, ["printf", "not json at all\n"], { feed: true }),
			},
		});

		const job = await ranOnce(dgHome, "fed");

		expect(job?.lastExitCode).toBe(1);
		expect(job?.lastError).toContain("line 1: not valid JSON");
	});

	it("gives stdout to the feed and stderr to the log file for feed true", async () => {
		const cwd = workDir();
		const { dgHome } = await boot({
			jobs: {
				both: tableEntry(
					cwd,
					scriptArgv(
						'console.log(JSON.stringify({id:"a",title:"Item A"}));console.error("from stderr")',
					),
					{ feed: true },
				),
			},
		});

		await ranOnce(dgHome, "both");

		const store = await openStoreAt(dgHome);
		try {
			expect(store.listFeedItems().map((item) => item.title)).toEqual([
				"Item A",
			]);
		} finally {
			store.close();
		}
		expect(logOf(dgHome, "both")).toContain("from stderr");
		expect(logOf(dgHome, "both")).not.toContain("Item A");
	});

	it("gives the service environment keys and the two grant keys to a run", async () => {
		const cwd = workDir();
		const out = join(cwd, "env.json");
		const { dgHome } = await boot({
			jobs: {
				env: tableEntry(
					cwd,
					scriptArgv(
						`require("node:fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env))`,
					),
					{ grant: "dg-test" },
				),
			},
		});

		await ranOnce(dgHome, "env");

		const env = JSON.parse(readFileSync(out, "utf8")) as Record<string, string>;
		expect(env.DG_SERVICE_LABEL).toBe("env");
		expect(env.DG_SERVICE_STATE_DIR).toContain("env");
		expect(env.DG_CREDENTIAL_GRANT_PREFIX).toBe("dg-test");
		expect(env.DG_CREDENTIAL_GRANT_FILE).toBeTruthy();
	});

	it("gives no grant keys to a run with no grant", async () => {
		const cwd = workDir();
		const out = join(cwd, "env.json");
		const { dgHome } = await boot({
			jobs: {
				env: tableEntry(
					cwd,
					scriptArgv(
						`require("node:fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env))`,
					),
				),
			},
		});

		await ranOnce(dgHome, "env");

		const env = JSON.parse(readFileSync(out, "utf8")) as Record<string, string>;
		expect(env.DG_SERVICE_LABEL).toBe("env");
		expect(env.DG_CREDENTIAL_GRANT_PREFIX).toBeUndefined();
		expect(env.DG_CREDENTIAL_GRANT_FILE).toBeUndefined();
	});
});

describe("scheduled run timing", () => {
	it("starts a failed run again only at the next scheduled time", async () => {
		const cwd = workDir();
		const counter = join(cwd, "count");
		const { dgHome } = await boot({
			jobs: {
				flaky: tableEntry(
					cwd,
					scriptArgv(
						`require("node:fs").appendFileSync(${JSON.stringify(counter)}, "x\\n");process.exit(1)`,
					),
				),
			},
		});

		const job = await ranOnce(dgHome, "flaky");
		await Bun.sleep(1_000);

		expect(job?.lastExitCode).toBe(1);
		expect(lineCount(counter)).toBe(1);
		const ranAt = new Date(job?.lastRunAt ?? 0).getTime();
		const next = new Date(
			(await jobByLabel(dgHome, "flaky"))?.nextRunAt ?? 0,
		).getTime();
		expect(next - ranAt).toBe(60 * 60_000);
	});

	it("skips a time while the run before it is in progress and never overlaps runs", async () => {
		const cwd = workDir();
		const trace = join(cwd, "trace");
		const script = `const fs=require("node:fs");fs.appendFileSync(${JSON.stringify(trace)},"start\\n");setTimeout(()=>{fs.appendFileSync(${JSON.stringify(trace)},"end\\n")},3000)`;
		const { dgHome } = await boot({
			jobs: { slow: tableEntry(cwd, scriptArgv(script), { every: "1s" }) },
		});

		await until(
			() => readDaemonLog(dgHome),
			(log) =>
				log.includes(
					"job slow: skipped a run, the run before it is not complete",
				),
			"logged the skipped run",
			10_000,
		);
		await Bun.sleep(3_500);

		const events = readFileSync(trace, "utf8").split("\n").filter(Boolean);
		events.forEach((event, index) => {
			expect(event).toBe(index % 2 === 0 ? "start" : "end");
		});
	}, 20_000);

	it("runs a job once at start after downtime of five intervals", async () => {
		const cwd = workDir();
		const counter = join(cwd, "count");
		const hour = 60 * 60_000;
		const { dgHome } = await boot({
			jobsVersion: 1,
			rows: [
				rowInput({
					label: "catchup",
					argv: appendLineArgv(counter, "run"),
					cwd,
					intervalMs: hour,
					nextRunAt: new Date(Date.now() - 5 * hour).toISOString(),
				}),
			],
		});

		await until(
			() => lineCount(counter),
			(count) => count >= 1,
			"ran the catch-up run",
		);
		await Bun.sleep(1_500);

		expect(lineCount(counter)).toBe(1);
		const job = await jobByLabel(dgHome, "catchup");
		expect(new Date(job?.nextRunAt ?? 0).getTime()).toBeGreaterThan(Date.now());
	});

	it("runs the two jobs of two rows at their times with no duplicate feed item", async () => {
		const cwd = workDir();
		const countA = join(cwd, "a");
		const countB = join(cwd, "b");
		const item = (id: string, file: string) =>
			scriptArgv(
				`require("node:fs").appendFileSync(${JSON.stringify(file)},"x\\n");console.log(JSON.stringify({id:${JSON.stringify(id)},title:${JSON.stringify(`Item ${id}`)}}))`,
			);
		const { dgHome } = await boot({
			jobsVersion: 1,
			rows: [
				rowInput({
					label: "first",
					argv: item("a", countA),
					cwd,
					intervalMs: QUARTER_HOUR_MS,
					nextRunAt: new Date(Date.now() - 1_000).toISOString(),
				}),
				rowInput({
					label: "second",
					argv: item("b", countB),
					cwd,
					intervalMs: QUARTER_HOUR_MS,
					nextRunAt: new Date(Date.now() - 1_000).toISOString(),
				}),
			],
		});

		await until(
			() => lineCount(countA) + lineCount(countB),
			(count) => count >= 2,
			"ran both jobs",
		);
		await Bun.sleep(1_000);

		expect([lineCount(countA), lineCount(countB)]).toEqual([1, 1]);
		const store = await openStoreAt(dgHome);
		try {
			expect(
				store
					.listFeedItems()
					.map((entry) => entry.title)
					.sort(),
			).toEqual(["Item a", "Item b"]);
		} finally {
			store.close();
		}
		expect(Object.keys(configOf(dgHome).jobs).sort()).toEqual([
			"first",
			"second",
		]);
	});
});

describe("scheduled run timeout", () => {
	it("ends a run that exceeds timeoutMs and records timed out after", async () => {
		const cwd = workDir();
		const { dgHome } = await boot({
			jobs: {
				hang: tableEntry(cwd, scriptArgv("setTimeout(()=>{},60000)"), {
					timeoutMs: 800,
				}),
			},
		});

		const job = await ranOnce(dgHome, "hang");

		expect(job?.lastExitCode).toBe(1);
		expect(job?.lastError).toContain("timed out after");
	});

	it("gives the result ok to a run that stays inside an explicit timeoutMs", async () => {
		const cwd = workDir();
		const { dgHome } = await boot({
			jobs: {
				fits: tableEntry(cwd, scriptArgv("setTimeout(()=>{},1000)"), {
					timeoutMs: 6000,
				}),
			},
		});

		const job = await ranOnce(dgHome, "fits");

		expect(job?.lastExitCode).toBe(0);
		expect(job?.lastError).toBeUndefined();
	});
});
