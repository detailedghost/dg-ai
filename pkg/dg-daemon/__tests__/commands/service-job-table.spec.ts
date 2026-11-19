import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DgCliError } from "@dg/common";
import { type AutostartDeps, resolveDgPaths } from "@dg/common/node";
import { ensureMigrated } from "../../src/commands/job-support";
import {
	allocatePort,
	bootServe,
	cleanupDgHome,
	createCleanupSlot,
	freshDgHome,
	freshTempDir,
	killDaemonByPidFile,
	readPidFile,
	spawnServe,
	stopServe,
	waitForHealth,
	waitForDaemonExit,
	waitForPidFile,
} from "../utils/daemon-harness";
import { configPathOf, writeConfigFile } from "../utils/service-daemon";
import { lines, readConfigFile, runCli } from "./service-cli-helpers";

const NOTE =
	'note: "dg-daemon service" is now "dg job"; this form goes away in the next major release';
const NOT_MIGRATED =
	"the daemon config is not migrated — run dg daemon start, then run this command again";

const homes: string[] = [];
const cleanups = createCleanupSlot();
afterEach(async () => {
	await cleanups.run();
	for (const home of homes.splice(0)) {
		killDaemonByPidFile(home);
		await waitForDaemonExit(home).catch(() => {});
		cleanupDgHome(home);
	}
});

function setup() {
	const dgHome = freshDgHome();
	homes.push(dgHome);
	return { dgHome, cwd: freshTempDir("svc-cwd"), port: allocatePort() };
}

const noteCount = (stderr: string) =>
	lines(stderr).filter((line) => line === NOTE).length;
const BUN = Bun.which("bun") as string;
const add = (
	dgHome: string,
	port: number,
	label: string,
	flags: string[],
	command = ["bun", "run", "bot.ts"],
) =>
	runCli(dgHome, ["service", "add", label, ...flags, "--", ...command], {
		port,
	});
const jobsOf = (dgHome: string) =>
	(readConfigFile(dgHome) as { jobs: Record<string, Record<string, unknown>> })
		.jobs;
const sleeperJob = (cwd: string) => ({
	argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
	cwd,
	continuous: true,
});

describe("service add on a migrated config", () => {
	it("writes jobs.x with continuous true, prints the stdout of today and the note once", async () => {
		const { dgHome, cwd, port } = setup();
		writeConfigFile(dgHome, { jobsVersion: 1 });
		const result = await add(dgHome, port, "x", ["--cwd", cwd]);
		expect(result.code).toBe(0);
		expect(lines(result.stdout)).toEqual([
			'added service "x"',
			"next: dg-daemon start, then dg-daemon service start x",
		]);
		expect(noteCount(result.stderr)).toBe(1);
		expect(jobsOf(dgHome).x).toEqual({
			argv: [BUN, "run", "bot.ts"],
			cwd,
			continuous: true,
		});
		expect(Object.hasOwn(readConfigFile(dgHome) as object, "services")).toBe(
			false,
		);
	});

	it("writes enabled true and no autostart key for --autostart", async () => {
		const { dgHome, cwd, port } = setup();
		writeConfigFile(dgHome, { jobsVersion: 1 });
		const result = await add(dgHome, port, "x", ["--cwd", cwd, "--autostart"]);
		expect(result.code).toBe(0);
		expect(lines(result.stdout)).toEqual([
			'added service "x"',
			"next: dg-daemon start",
		]);
		expect(jobsOf(dgHome).x).toEqual({
			argv: [BUN, "run", "bot.ts"],
			cwd,
			continuous: true,
			enabled: true,
		});
	});

	it("writes jobs.x on a config whose services value is not an object and keeps that value", async () => {
		const { dgHome, cwd, port } = setup();
		writeConfigFile(dgHome, { jobsVersion: 1, services: [1] });
		const result = await add(dgHome, port, "x", ["--cwd", cwd]);
		expect(result.code).toBe(0);
		expect(jobsOf(dgHome).x).toBeDefined();
		expect((readConfigFile(dgHome) as { services: unknown }).services).toEqual([
			1,
		]);
	});

	it("refuses a name that is already a job", async () => {
		const { dgHome, cwd, port } = setup();
		writeConfigFile(dgHome, {
			jobsVersion: 1,
			jobs: { x: sleeperJob(cwd) },
		});
		const result = await add(dgHome, port, "x", ["--cwd", cwd]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('a service labelled "x" already exists');
	});
});

describe("service add on a config with no jobsVersion", () => {
	it("starts the daemon one time and writes jobs.x beside the moved services, with no config lock held during the wait", async () => {
		const { dgHome, cwd, port } = setup();
		writeConfigFile(dgHome, {
			services: { old: { argv: ["/bin/x"], cwd, autostart: true } },
		});
		const result = await add(dgHome, port, "x", ["--cwd", cwd]);
		expect(result.code).toBe(0);
		const config = readConfigFile(dgHome) as Record<string, unknown>;
		expect(Object.hasOwn(config, "services")).toBe(false);
		expect(config.jobsVersion).toBe(1);
		const jobs = config.jobs as Record<string, unknown>;
		expect(Object.keys(jobs).sort()).toEqual(["old", "x"]);
		expect(jobs.old).toEqual({
			argv: ["/bin/x"],
			cwd,
			continuous: true,
			enabled: true,
		});
		const pid = (await waitForPidFile(dgHome)).pid;
		expect(Number.isInteger(pid)).toBe(true);
	}, 45_000);

	it("exits 1 with the not migrated text and writes nothing when the daemon cannot start", async () => {
		const { dgHome, cwd, port } = setup();
		const body = JSON.stringify({ services: { old: { argv: ["/b"], cwd } } });
		writeConfigFile(dgHome, body);
		const blocker = createServer().listen(port, "127.0.0.1");
		await new Promise((resolve) => blocker.once("listening", resolve));
		try {
			const result = await add(dgHome, port, "x", ["--cwd", cwd]);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain(NOT_MIGRATED);
		} finally {
			blocker.close();
		}
		const config = readConfigFile(dgHome) as {
			jobs?: Record<string, unknown>;
		};
		expect(Object.keys(config.jobs ?? {})).not.toContain("x");
	}, 45_000);
});

describe("ensureMigrated", () => {
	const inertAutostart: AutostartDeps = {
		platform: "linux",
		homeDir: join(tmpdir(), "dg-ensure-migrated-no-unit"),
		env: {},
		uid: 1000,
		writeFile: () => {},
		removeFile: () => {},
		fileExists: () => false,
		run: async (argv) => {
			throw new Error(`unexpected manager command: ${argv.join(" ")}`);
		},
	};

	it("fails with the not migrated text and exit code 1 when the daemon start throws", async () => {
		const { dgHome } = setup();
		writeConfigFile(dgHome, { services: {} });
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		const failure = await ensureMigrated(paths, {
			autostart: inertAutostart,
			spawn: (() => {
				throw new Error("spawn refused");
			}) as never,
		}).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(DgCliError);
		expect((failure as DgCliError).message).toBe(NOT_MIGRATED);
		expect((failure as DgCliError).exitCode).toBe(1);
	});

	it("returns at once on a config that has the mark", async () => {
		const { dgHome } = setup();
		writeConfigFile(dgHome, { jobsVersion: 1 });
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		await expect(
			ensureMigrated(paths, {
				autostart: inertAutostart,
				spawn: (() => {
					throw new Error("must not spawn");
				}) as never,
			}),
		).resolves.toBeUndefined();
	});
});

describe("service add against a live daemon that left no mark", () => {
	it("starts no daemon, waits at most 10 s, exits 1 with the earlier release text and keeps the daemon", async () => {
		const { cwd } = setup();
		const boot = await bootServe();
		cleanups.set(async () => {
			await stopServe(boot.proc);
			cleanupDgHome(boot.dgHome);
		});
		const body = JSON.stringify({ services: { old: { argv: ["/b"], cwd } } });
		writeConfigFile(boot.dgHome, body);
		const paths = resolveDgPaths({ env: { DG_HOME: boot.dgHome } });
		const current = readPidFile(boot.dgHome);
		writeFileSync(
			paths.pidPath,
			JSON.stringify({
				...current,
				versions: { ...current.versions, package: "0.0.1" },
			}),
		);
		const before = readPidFile(boot.dgHome);
		const started = Date.now();
		const result = await runCli(
			boot.dgHome,
			["service", "add", "x", "--cwd", cwd, "--", "bun", "run", "bot.ts"],
			{ port: boot.port },
		);
		expect(Date.now() - started).toBeLessThan(25_000);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			`the daemon config is not migrated — a dg-daemon from before this release runs (pid ${before.pid}); run dg daemon restart, then run this command again`,
		);
		expect(readFileSync(configPathOf(boot.dgHome), "utf8")).toBe(body);
		expect(readPidFile(boot.dgHome)).toEqual(before);
		expect(() => process.kill(before.pid, 0)).not.toThrow();
	}, 45_000);
});

describe("service add against a live daemon of this release that cannot write the mark", () => {
	it("exits 1 with the daemon log text, not the earlier release text, and writes nothing", async () => {
		const { dgHome, cwd, port } = setup();
		const body = JSON.stringify({
			services: { dup: { argv: ["/b"], cwd } },
			jobs: { dup: { argv: ["/b"], cwd, continuous: true } },
		});
		writeConfigFile(dgHome, body);
		const proc = spawnServe(dgHome, port);
		cleanups.set(async () => {
			await stopServe(proc);
		});
		await waitForHealth(port);
		const pid = readPidFile(dgHome).pid;
		const result = await add(dgHome, port, "x", ["--cwd", cwd]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			`the daemon config is not migrated — the dg-daemon (pid ${pid}) did not write the mark; see the daemon log`,
		);
		expect(result.stderr).not.toContain("from before this release");
		expect(readFileSync(configPathOf(dgHome), "utf8")).toBe(body);
	}, 45_000);
});

describe("service add that starts a daemon which never writes the mark", () => {
	it("fails after the short wait with the daemon log text and leaves the config unchanged", async () => {
		const { dgHome, cwd, port } = setup();
		const body = JSON.stringify({
			services: { dup: { argv: ["/b"], cwd } },
			jobs: { dup: { argv: ["/b"], cwd, continuous: true } },
		});
		writeConfigFile(dgHome, body);
		const result = await add(dgHome, port, "x", ["--cwd", cwd]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			"did not write the mark; see the daemon log",
		);
		expect(result.stderr).not.toContain("from before this release");
		expect(readFileSync(configPathOf(dgHome), "utf8")).toBe(body);
	}, 45_000);
});

describe("service verbs on the jobs table", () => {
	it("rm of a scheduled entry exits 1 with the label text and deletes nothing", async () => {
		const { dgHome, cwd, port } = setup();
		const body = JSON.stringify({
			jobsVersion: 1,
			jobs: { tick: { argv: ["/b"], cwd, every: "15m" } },
		});
		writeConfigFile(dgHome, body);
		const result = await runCli(dgHome, ["service", "rm", "tick"], { port });
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('no service labelled "tick"');
		expect(readFileSync(configPathOf(dgHome), "utf8")).toBe(body);
	});

	it("rm removes a continuous entry from jobs", async () => {
		const { dgHome, cwd, port } = setup();
		writeConfigFile(dgHome, {
			jobsVersion: 1,
			jobs: { bot: { argv: ["/b"], cwd, continuous: true } },
		});
		const result = await runCli(dgHome, ["service", "rm", "bot"], { port });
		expect(result.code).toBe(0);
		expect(lines(result.stdout)).toEqual(['removed service "bot"']);
		expect(noteCount(result.stderr)).toBe(1);
		expect(jobsOf(dgHome)).toEqual({});
	});

	it("status, start and stop use the jobs table, keep their stdout and print the note once", async () => {
		const boot = await bootServe();
		cleanups.set(async () => {
			await runCli(boot.dgHome, ["service", "stop", "bot"], {
				port: boot.port,
			});
			await stopServe(boot.proc);
			cleanupDgHome(boot.dgHome);
		});
		await waitForPidFile(boot.dgHome);
		writeConfigFile(boot.dgHome, {
			jobsVersion: 1,
			jobs: { bot: sleeperJob(boot.dgHome) },
		});
		const run = (...args: string[]) =>
			runCli(boot.dgHome, ["service", ...args], { port: boot.port });

		const started = await run("start", "bot");
		expect(started.code).toBe(0);
		expect(started.stdout).toContain("bot  running");
		expect(noteCount(started.stderr)).toBe(1);

		const status = await run("status");
		expect(status.stdout).toContain("bot  running");
		expect(noteCount(status.stderr)).toBe(1);

		const json = await run("status", "--json");
		const parsed = JSON.parse(json.stdout);
		expect(Object.keys(parsed)).toEqual(["services"]);
		expect(parsed.services[0]).toMatchObject({ label: "bot" });
		expect(noteCount(json.stderr)).toBe(1);

		const stopped = await run("stop", "bot");
		expect(stopped.stdout).toContain("bot  stopped");
		expect(noteCount(stopped.stderr)).toBe(1);
	}, 30_000);
});
