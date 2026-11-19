import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import { CHAT_JOBS_PATH, CHAT_PROTOCOL_VERSION } from "@dg/common";
import { writePidFileAtomic } from "@dg/common/node";
import { freshTempDir } from "../utils/daemon-harness";
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

const RUNNING_LINE = /^x +running +pid \d+/;
const STOPPED_LINE = /^x +stopped/;
const readBytes = (dgHome: string) => readFileSync(configPathOf(dgHome), "utf8");

describe("job enable", () => {
	it("enables a stopped job on a live daemon and prints the running status line", async () => {
		const { dgHome, port } = await homes.boot((cwd) => ({
			x: sleeperEntry(cwd),
		}));

		const result = await runCli(dgHome, ["job", "enable", "x"], { port });

		expect(result.code).toBe(0);
		const out = lines(result.stdout);
		expect(out[0]).toBe('enabled job "x"');
		expect(out[1]).toMatch(RUNNING_LINE);
		expect((await fetchJobRows(dgHome, port))[0].state).toBe("running");
	});

	it("adds enabled true and keeps each other key, entry, key and the file mode", async () => {
		const { dgHome, port } = await homes.boot((cwd) => ({
			x: sleeperEntry(cwd, { passEnv: ["PATH"] }),
			other: sleeperEntry(cwd),
		}));
		chmodSync(configPathOf(dgHome), 0o640);
		const before = readConfigFile(dgHome) as Record<string, unknown>;

		const result = await runCli(dgHome, ["job", "enable", "x"], { port });

		expect(result.code).toBe(0);
		const after = readConfigFile(dgHome) as Record<string, unknown>;
		expect(jobsTable(after).x).toEqual({ ...jobsTable(before).x, enabled: true });
		expect(jobsTable(after).other).toEqual(jobsTable(before).other);
		expect(after.pinnedOrigin).toBe(before.pinnedOrigin);
		expect(after.jobsVersion).toBe(before.jobsVersion);
		expect(statSync(configPathOf(dgHome)).mode & 0o777).toBe(0o640);
	});

	it("prints the invalid status line when the daemon cannot parse the entry", async () => {
		const { dgHome, port } = await homes.boot((cwd) => ({
			x: sleeperEntry(cwd, { bogusKey: 1 }),
		}));

		const result = await runCli(dgHome, ["job", "enable", "x"], { port });

		expect(lines(result.stdout)[1]).toMatch(/^x +invalid.*bogusKey/);
	});

	it("writes no file the second time", async () => {
		const { dgHome, port } = await homes.boot((cwd) => ({
			x: sleeperEntry(cwd),
		}));
		await runCli(dgHome, ["job", "enable", "x"], { port });
		const bytes = readBytes(dgHome);
		const mtime = statSync(configPathOf(dgHome)).mtimeMs;

		const second = await runCli(dgHome, ["job", "enable", "x"], { port });

		expect(second.code).toBe(0);
		expect(readBytes(dgHome)).toBe(bytes);
		expect(statSync(configPathOf(dgHome)).mtimeMs).toBe(mtime);
	});

	it("starts the daemon one time when none runs, then prints the running status line", async () => {
		const dgHome = homes.fresh();
		seedJobs(dgHome, { x: sleeperEntry(freshTempDir("job-cwd")) });
		expect(existsSync(pathsOf(dgHome).pidPath)).toBe(false);

		const result = await runCli(dgHome, ["job", "enable", "x"]);

		expect(result.code).toBe(0);
		const out = lines(result.stdout);
		expect(out[0]).toBe('enabled job "x"');
		expect(out[1]).toMatch(RUNNING_LINE);
		expect(result.stdout).not.toContain("dg-daemon started on");
		expect(existsSync(pathsOf(dgHome).pidPath)).toBe(true);
	});

	it("still starts the daemon for an entry that is enabled already, and exits 0 when the daemon starts the job first", async () => {
		const dgHome = homes.fresh();
		seedJobs(dgHome, {
			x: sleeperEntry(freshTempDir("job-cwd"), { enabled: true }),
		});
		const before = readBytes(dgHome);

		const result = await runCli(dgHome, ["job", "enable", "x"]);

		expect(result.code).toBe(0);
		expect(existsSync(pathsOf(dgHome).pidPath)).toBe(true);
		expect(lines(result.stdout)[1]).toMatch(RUNNING_LINE);
		expect(readBytes(dgHome)).toBe(before);
	});

	it("leaves a running job alone: same pid, no restart", async () => {
		const { dgHome, port } = await homes.boot((cwd) => ({
			x: sleeperEntry(cwd),
		}));
		expect((await postJob(port, "x", "start")).ok).toBe(true);
		const pidBefore = (await fetchJobRows(dgHome, port))[0].pid;

		const result = await runCli(dgHome, ["job", "enable", "x"], { port });

		expect(result.code).toBe(0);
		const out = lines(result.stdout);
		expect(out[0]).toBe('enabled job "x"');
		expect(out[1]).toMatch(RUNNING_LINE);
		expect(out[1]).toContain(`pid ${pidBefore}`);
	});

	it("sends no start request for a job that is not stopped", async () => {
		const dgHome = homes.fresh();
		seedJobs(dgHome, { x: sleeperEntry(freshTempDir("job-cwd")) });
		const fake = startFakeDaemon(dgHome, () =>
			Response.json({
				instanceId: "i",
				jobs: [{ label: "x", state: "running", pid: 42, restarts: 0, logFile: "/l" }],
			}),
		);
		stoppers.push(fake.stop);

		const result = await runCli(dgHome, ["job", "enable", "x"]);

		expect(result.code).toBe(0);
		expect(fake.requests.some((r) => r.startsWith("POST"))).toBe(false);
	});

	it("reads a conflict answer of the start route as success", async () => {
		const dgHome = homes.fresh();
		seedJobs(dgHome, { x: sleeperEntry(freshTempDir("job-cwd")) });
		const fake = startFakeDaemon(dgHome, (method) =>
			method === "POST"
				? new Response('"x" is already running', { status: 409 })
				: Response.json({
						instanceId: "i",
						jobs: [{ label: "x", state: "stopped", pid: null, restarts: 0, logFile: "/l" }],
					}),
		);
		stoppers.push(fake.stop);

		const result = await runCli(dgHome, ["job", "enable", "x"]);

		expect(result.code).toBe(0);
		expect(lines(result.stdout)[0]).toBe('enabled job "x"');
		expect(fake.requests).toContain(`POST ${CHAT_JOBS_PATH}/x/start`);
	});

	it("keeps enabled true, exits 1 and prints the daemon text when the start request fails", async () => {
		const dgHome = homes.fresh();
		seedJobs(dgHome, { x: sleeperEntry(freshTempDir("job-cwd")) });
		const fake = startFakeDaemon(dgHome, (method) =>
			method === "POST"
				? new Response("the daemon could not start x", { status: 500 })
				: Response.json({
						instanceId: "i",
						jobs: [{ label: "x", state: "stopped", pid: null, restarts: 0, logFile: "/l" }],
					}),
		);
		stoppers.push(fake.stop);

		const result = await runCli(dgHome, ["job", "enable", "x"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("the daemon could not start x");
		expect(jobsTable(readConfigFile(dgHome)).x.enabled).toBe(true);
	});

	it("refuses an unknown name and writes nothing", async () => {
		const dgHome = homes.fresh();
		seedJobs(dgHome, {});
		const before = readBytes(dgHome);

		const result = await runCli(dgHome, ["job", "enable", "ghost"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('no job named "ghost"');
		expect(readBytes(dgHome)).toBe(before);
	});

	it("refuses an entry that is not an object and leaves the file as it is", async () => {
		const dgHome = homes.fresh();
		seedJobs(dgHome, { x: "oops" });
		const before = readBytes(dgHome);

		const result = await runCli(dgHome, ["job", "enable", "x"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			`job "x" in ${configPathOf(dgHome)} is not an object`,
		);
		expect(readBytes(dgHome)).toBe(before);
	});

	it("exits 1, names the file and keeps it when the config is not valid JSON", async () => {
		const dgHome = homes.fresh();
		writeConfigFile(dgHome, "{ not json");

		const result = await runCli(dgHome, ["job", "enable", "x"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(configPathOf(dgHome));
		expect(readBytes(dgHome)).toBe("{ not json");
	});

	it("refuses to write when a daemon pid is alive and does not answer", async () => {
		const dgHome = homes.fresh();
		seedJobs(dgHome, { x: sleeperEntry(freshTempDir("job-cwd")) });
		writePidFileAtomic(pathsOf(dgHome), {
			pid: process.pid,
			port: 1,
			instanceId: crypto.randomUUID(),
			versions: { package: "9.9.9", protocol: CHAT_PROTOCOL_VERSION },
		});
		const before = readBytes(dgHome);

		const result = await runCli(dgHome, ["job", "enable", "x"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("does not answer");
		expect(readBytes(dgHome)).toBe(before);
	});

	it("hints at the login unit when there is no terminal and no unit, and asks nothing", async () => {
		const { dgHome, port } = await homes.boot((cwd) => ({
			x: sleeperEntry(cwd),
		}));

		const result = await runCli(dgHome, ["job", "enable", "x"], { port });

		expect(result.code).toBe(0);
		expect(result.stderr).toContain(
			"hint: dg does not start at login — run dg autostart install",
		);
		expect(result.stderr).not.toContain("Start dg at login");
	});

	it("exits 1 with the older-than-the-CLI text when the daemon has no start route", async () => {
		const dgHome = homes.fresh();
		seedJobs(dgHome, { x: sleeperEntry(freshTempDir("job-cwd")) });
		const fake = startFakeDaemon(dgHome, (method) =>
			method === "POST"
				? new Response("not found", { status: 404 })
				: Response.json({ instanceId: "i", jobs: [] }),
		);
		stoppers.push(fake.stop);

		const result = await runCli(dgHome, ["job", "start", "x"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			"this dg-daemon is older than the CLI — run dg daemon restart",
		);
	});

	it("prints the body of a 404 that names the job", async () => {
		const dgHome = homes.fresh();
		seedJobs(dgHome, { x: sleeperEntry(freshTempDir("job-cwd")) });
		const fake = startFakeDaemon(dgHome, (method) =>
			method === "POST"
				? new Response('no job named "x"', { status: 404 })
				: Response.json({ instanceId: "i", jobs: [] }),
		);
		stoppers.push(fake.stop);

		const result = await runCli(dgHome, ["job", "start", "x"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('no job named "x"');
		expect(result.stderr).not.toContain("older than the CLI");
	});
});

describe("job disable", () => {
	it("deletes the enabled key and keeps each other key", async () => {
		const dgHome = homes.fresh();
		seedJobs(dgHome, {
			x: sleeperEntry(freshTempDir("job-cwd"), { enabled: true, passEnv: ["PATH"] }),
		});
		const before = jobsTable(readConfigFile(dgHome)).x;

		const result = await runCli(dgHome, ["job", "disable", "x"]);

		expect(result.code).toBe(0);
		const { enabled: _enabled, ...rest } = before;
		expect(jobsTable(readConfigFile(dgHome)).x).toEqual(rest);
	});

	it("exits 0 with no daemon, makes no HTTP call and starts no daemon", async () => {
		const dgHome = homes.fresh();
		seedJobs(dgHome, {
			x: sleeperEntry(freshTempDir("job-cwd"), { enabled: true }),
		});

		const result = await runCli(dgHome, ["job", "disable", "x"]);

		expect(result.code).toBe(0);
		expect(lines(result.stdout)).toEqual(['disabled job "x"']);
		expect(existsSync(pathsOf(dgHome).pidPath)).toBe(false);
	});

	it("stops a running job and prints the stopped status line", async () => {
		const { dgHome, port } = await homes.boot((cwd) => ({
			x: sleeperEntry(cwd, { enabled: true }),
		}));
		expect((await postJob(port, "x", "start")).ok).toBe(true);

		const result = await runCli(dgHome, ["job", "disable", "x"], { port });

		expect(result.code).toBe(0);
		const out = lines(result.stdout);
		expect(out[0]).toBe('disabled job "x"');
		expect(out[1]).toMatch(STOPPED_LINE);
		expect((await fetchJobRows(dgHome, port))[0].state).toBe("stopped");
	});

	it("writes nothing when enabled is absent already", async () => {
		const dgHome = homes.fresh();
		seedJobs(dgHome, { x: sleeperEntry(freshTempDir("job-cwd")) });
		const before = readBytes(dgHome);
		const mtime = statSync(configPathOf(dgHome)).mtimeMs;

		const result = await runCli(dgHome, ["job", "disable", "x"]);

		expect(result.code).toBe(0);
		expect(readBytes(dgHome)).toBe(before);
		expect(statSync(configPathOf(dgHome)).mtimeMs).toBe(mtime);
	});

	it("refuses an unknown name and an entry that is not an object", async () => {
		const dgHome = homes.fresh();
		seedJobs(dgHome, { bad: 5 });
		const before = readBytes(dgHome);

		const unknown = await runCli(dgHome, ["job", "disable", "ghost"]);
		const notObject = await runCli(dgHome, ["job", "disable", "bad"]);

		expect(unknown.code).toBe(1);
		expect(unknown.stderr).toContain('no job named "ghost"');
		expect(notObject.code).toBe(1);
		expect(notObject.stderr).toContain(
			`job "bad" in ${configPathOf(dgHome)} is not an object`,
		);
		expect(readBytes(dgHome)).toBe(before);
	});

	it("refuses to write when a daemon pid is alive and does not answer", async () => {
		const dgHome = homes.fresh();
		seedJobs(dgHome, {
			x: sleeperEntry(freshTempDir("job-cwd"), { enabled: true }),
		});
		writePidFileAtomic(pathsOf(dgHome), {
			pid: process.pid,
			port: 1,
			instanceId: crypto.randomUUID(),
			versions: { package: "9.9.9", protocol: CHAT_PROTOCOL_VERSION },
		});
		const before = readBytes(dgHome);

		const result = await runCli(dgHome, ["job", "disable", "x"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("does not answer");
		expect(readBytes(dgHome)).toBe(before);
	});
});
