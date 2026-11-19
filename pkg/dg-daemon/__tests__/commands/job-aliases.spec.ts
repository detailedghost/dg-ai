import { afterEach, describe, expect, it } from "bun:test";
import { freshTempDir } from "../utils/daemon-harness";
import { homeTracker, runCli, seedJobs, sleeperEntry } from "./job-cli-helpers";

const homes = homeTracker();
afterEach(() => homes.cleanup());

const TAIL = "this form goes away in the next major release";
const note = (oldForm: string, newForm: string) =>
	`note: "${oldForm}" is now "${newForm}"; ${TAIL}`;
const countOf = (text: string, needle: string) => text.split(needle).length - 1;
const noteLines = (stderr: string) =>
	stderr.split("\n").filter((line) => line.startsWith("note:") && line.includes("is now"));

const CMD = [process.execPath, "-e", "1"];

function seeded(jobs: Record<string, unknown> = {}) {
	const dgHome = homes.fresh();
	seedJobs(dgHome, jobs);
	return dgHome;
}

const add = (flags: string[]) => [
	"job",
	"add",
	...flags,
	"--cwd",
	freshTempDir("job-cwd"),
	"--",
	...CMD,
];

describe("alias notes of the job group", () => {
	it("--label prints its note one time and --name prints none", async () => {
		const alias = await runCli(seeded(), add(["--label", "x", "--every", "15m"]));
		const fresh = await runCli(seeded(), add(["--name", "x", "--every", "15m"]));

		expect(alias.code).toBe(0);
		expect(countOf(alias.stderr, note("--label", "--name"))).toBe(1);
		expect(noteLines(fresh.stderr)).toEqual([]);
	});

	it("--cron prints its note one time and --schedule prints none", async () => {
		const alias = await runCli(seeded(), add(["--name", "x", "--cron", "0 9 * * *"]));
		const fresh = await runCli(seeded(), add(["--name", "x", "--schedule", "0 9 * * *"]));

		expect(alias.code).toBe(0);
		expect(countOf(alias.stderr, note("--cron", "--schedule"))).toBe(1);
		expect(noteLines(fresh.stderr)).toEqual([]);
	});

	it("--pass-env prints its note one time, with the stdout of --env", async () => {
		const alias = await runCli(
			seeded(),
			add(["--name", "x", "--continuous", "--pass-env", "PATH"]),
		);
		const fresh = await runCli(
			seeded(),
			add(["--name", "x", "--continuous", "--env", "PATH"]),
		);

		expect(countOf(alias.stderr, note("--pass-env", "--env"))).toBe(1);
		expect(noteLines(fresh.stderr)).toEqual([]);
		expect(alias.stdout).toBe(fresh.stdout);
	});

	it("rm prints its note one time and remove prints none", async () => {
		const cwd = freshTempDir("job-cwd");
		const viaRm = await runCli(seeded({ x: sleeperEntry(cwd) }), ["job", "rm", "x"]);
		const viaRemove = await runCli(seeded({ x: sleeperEntry(cwd) }), [
			"job",
			"remove",
			"x",
		]);

		expect(viaRm.code).toBe(0);
		expect(countOf(viaRm.stderr, note("job rm", "job remove"))).toBe(1);
		expect(viaRm.stdout).toBe(viaRemove.stdout);
		expect(noteLines(viaRemove.stderr)).toEqual([]);
	});

	it("run and exec print each their own note and start prints none", async () => {
		const cwd = freshTempDir("job-cwd");
		const scheduled = async (verb: string) => {
			const dgHome = seeded();
			await runCli(dgHome, [
				"job",
				"add",
				"--label",
				"x",
				"--every",
				"15m",
				"--cwd",
				cwd,
				"--",
				"printf",
				'{"id":"a","title":"A"}\n',
			]);
			return runCli(dgHome, ["job", verb, "x"]);
		};

		const run = await scheduled("run");
		const exec = await scheduled("exec");
		const start = await scheduled("start");

		expect(countOf(run.stderr, note("job run", "job start"))).toBe(1);
		expect(countOf(exec.stderr, note("job exec", "job start"))).toBe(1);
		expect(noteLines(start.stderr)).toEqual([]);
		expect(run.stdout).toBe(start.stdout);
		expect(exec.stdout).toBe(start.stdout);
	});
});
