import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { CHAT_JOBS_PATH } from "@dg/common";
import { freshTempDir } from "../utils/daemon-harness";
import { configPathOf } from "../utils/service-daemon";
import {
	homeTracker,
	lines,
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

const jobRows = (state: string) =>
	Response.json({
		instanceId: "i",
		jobs: [{ label: "x", state, pid: 7, restarts: 0, logFile: "/l" }],
	});

describe("job restart", () => {
	it("starts a stopped job", async () => {
		const { dgHome, port } = await homes.boot((cwd) => ({
			x: sleeperEntry(cwd),
		}));

		const result = await runCli(dgHome, ["job", "restart", "x"], { port });

		expect(result.code).toBe(0);
		expect(lines(result.stdout).at(-1)).toMatch(/^x +running +pid \d+/);
	});

	it("exits 1 with the no-daemon text when none runs", async () => {
		const dgHome = homes.fresh();
		seedJobs(dgHome, { x: sleeperEntry(freshTempDir("job-cwd")) });

		const result = await runCli(dgHome, ["job", "restart", "x"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			"no live dg-daemon — jobs run inside it, so start it with dg daemon start",
		);
	});

	it("names an unknown job even when no daemon runs", async () => {
		const dgHome = homes.fresh();
		seedJobs(dgHome, {});

		const result = await runCli(dgHome, ["job", "restart", "ghost"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('no job named "ghost"');
	});

	it("sends no start request when the stop request fails", async () => {
		const dgHome = homes.fresh();
		seedJobs(dgHome, { x: sleeperEntry(freshTempDir("job-cwd")) });
		const fake = startFakeDaemon(dgHome, (method) =>
			method === "POST"
				? new Response("the daemon could not stop x", { status: 500 })
				: jobRows("running"),
		);
		stoppers.push(fake.stop);

		const result = await runCli(dgHome, ["job", "restart", "x"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("the daemon could not stop x");
		expect(fake.requests).toContain(`POST ${CHAT_JOBS_PATH}/x/stop`);
		expect(fake.requests).not.toContain(`POST ${CHAT_JOBS_PATH}/x/start`);
	});

	it("sends the stop request, then the start request", async () => {
		const dgHome = homes.fresh();
		seedJobs(dgHome, { x: sleeperEntry(freshTempDir("job-cwd")) });
		const fake = startFakeDaemon(dgHome, (method) =>
			method === "POST" ? Response.json({ label: "x", state: "running", pid: 7, restarts: 0, logFile: "/l" }) : jobRows("running"),
		);
		stoppers.push(fake.stop);

		const result = await runCli(dgHome, ["job", "restart", "x"]);

		expect(result.code).toBe(0);
		expect(fake.requests.filter((r) => r.startsWith("POST"))).toEqual([
			`POST ${CHAT_JOBS_PATH}/x/stop`,
			`POST ${CHAT_JOBS_PATH}/x/start`,
		]);
	});
});

describe("job start and job stop", () => {
	it("start runs the job now and leaves enabled as it was; stop stops it", async () => {
		const { dgHome, port } = await homes.boot((cwd) => ({
			x: sleeperEntry(cwd),
		}));
		const before = readFileSync(configPathOf(dgHome), "utf8");

		const started = await runCli(dgHome, ["job", "start", "x"], { port });
		expect(started.code).toBe(0);
		expect(lines(started.stdout).at(-1)).toMatch(/^x +running +pid \d+/);

		const stopped = await runCli(dgHome, ["job", "stop", "x"], { port });
		expect(stopped.code).toBe(0);
		expect(lines(stopped.stdout).at(-1)).toMatch(/^x +stopped/);
		expect(readFileSync(configPathOf(dgHome), "utf8")).toBe(before);
	});

	it("stop of a stopped job prints the stopped status line and exits 0", async () => {
		const { dgHome, port } = await homes.boot((cwd) => ({
			x: sleeperEntry(cwd, { enabled: true }),
		}));
		const before = readFileSync(configPathOf(dgHome), "utf8");

		const result = await runCli(dgHome, ["job", "stop", "x"], { port });

		expect(result.code).toBe(0);
		expect(lines(result.stdout).at(-1)).toMatch(/^x +stopped/);
		expect(readFileSync(configPathOf(dgHome), "utf8")).toBe(before);
	});

	it("start and stop name an unknown job", async () => {
		const { dgHome, port } = await homes.boot();

		for (const verb of ["start", "stop"]) {
			const result = await runCli(dgHome, ["job", verb, "ghost"], { port });
			expect(result.code).toBe(1);
			expect(result.stderr).toContain('no job named "ghost"');
		}
	});

	it("start of a scheduled job needs a live daemon", async () => {
		const dgHome = homes.fresh();
		seedJobs(
			dgHome,
			{
				nightly: {
					every: "15m",
					argv: ["printf", ""],
					cwd: freshTempDir("job-cwd"),
				},
			},
			{ jobsVersion: 2 },
		);

		const result = await runCli(dgHome, ["job", "start", "nightly"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("no live dg-daemon");
	});
});

describe("job stop of a scheduled job", () => {
	it("needs a live daemon, like the stop of a continuous job", async () => {
		const dgHome = homes.fresh();
		seedJobs(
			dgHome,
			{
				nightly: {
					every: "15m",
					argv: ["printf", ""],
					cwd: freshTempDir("job-cwd"),
				},
			},
			{ jobsVersion: 2 },
		);

		const result = await runCli(dgHome, ["job", "stop", "nightly"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("no live dg-daemon");
	});
});
