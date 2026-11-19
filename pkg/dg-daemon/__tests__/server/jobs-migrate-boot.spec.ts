import { afterEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { CHAT_JOBS_PATH, OWNER_TOKEN_HEADER } from "@dg/common";
import { readOwnerToken, resolveDgPaths } from "@dg/common/node";
import {
	allocatePort,
	cleanupDgHome,
	freshDgHome,
	killDaemonByPidFile,
	readDaemonLog,
	spawnServe,
	waitForDaemonExit,
	waitForHealth,
	waitForValue,
} from "../utils/daemon-harness";
import { writeConfigFile } from "../utils/service-daemon";

type Booted = {
	dgHome: string;
	port: number;
	paths: ReturnType<typeof resolveDgPaths>;
	proc: ReturnType<typeof spawnServe>;
};

const booted: Booted[] = [];
const extraProcs: Array<{ kill: () => void }> = [];

afterEach(async () => {
	for (const proc of extraProcs.splice(0)) proc.kill();
	for (const { dgHome, proc } of booted.splice(0)) {
		killDaemonByPidFile(dgHome);
		proc.kill("SIGKILL");
		await proc.exited;
		await waitForDaemonExit(dgHome).catch(() => {});
		cleanupDgHome(dgHome);
	}
});

async function bootOn(dgHome: string, config?: unknown): Promise<Booted> {
	if (config !== undefined) writeConfigFile(dgHome, config);
	const port = allocatePort();
	const proc = spawnServe(dgHome, port);
	const daemon = {
		dgHome,
		port,
		proc,
		paths: resolveDgPaths({ env: { DG_HOME: dgHome } }),
	};
	booted.push(daemon);
	await waitForHealth(port, 8000);
	return daemon;
}

const sleeper = (cwd: string, extra: Record<string, unknown> = {}) => ({
	argv: [process.execPath, "-e", "setInterval(() => {}, 1000)", "SECRET-ARG"],
	cwd,
	...extra,
});

const configOf = (daemon: Booted) =>
	JSON.parse(readFileSync(daemon.paths.daemonConfigPath, "utf8"));

async function listJobs(daemon: Booted) {
	const resp = await fetch(`http://127.0.0.1:${daemon.port}${CHAT_JOBS_PATH}`, {
		headers: {
			Host: `127.0.0.1:${daemon.port}`,
			[OWNER_TOKEN_HEADER]: readOwnerToken(daemon.paths) as string,
		},
	});
	return (await resp.json()).jobs as Array<{
		label: string;
		state: string;
		error: string | null;
	}>;
}

describe("daemon boot with a services table", () => {
	it("moves services to jobs, starts the autostart job and keeps the backup", async () => {
		const dgHome = freshDgHome();
		const before = {
			pinnedOrigin: "p",
			services: {
				bot: sleeper(dgHome, { autostart: true }),
				idle: sleeper(dgHome),
			},
		};
		const daemon = await bootOn(dgHome, before);
		let jobs = await listJobs(daemon);
		for (
			let i = 0;
			i < 100 && jobs.find((j) => j.label === "bot")?.state !== "running";
			i++
		) {
			await Bun.sleep(50);
			jobs = await listJobs(daemon);
		}
		expect(jobs.find((job) => job.label === "bot")?.state).toBe("running");
		expect(jobs.find((job) => job.label === "idle")?.state).toBe("stopped");
		const config = configOf(daemon);
		expect(Object.hasOwn(config, "services")).toBe(false);
		expect(config.pinnedOrigin).toBe("p");
		expect(config.jobsVersion).toBe(2);
		const { autostart: _autostart, ...botRest } = before.services.bot as Record<
			string,
			unknown
		>;
		expect(config.jobs.bot).toEqual({
			...botRest,
			continuous: true,
			enabled: true,
		});
		expect(config.jobs.idle).toEqual({
			...before.services.idle,
			continuous: true,
		});
		const backup = join(daemon.paths.daemonDir, "config.json.pre-jobs");
		expect(JSON.parse(readFileSync(backup, "utf8"))).toEqual(before);
	}, 20_000);

	it("logs one info line with the count and the backup path and no argv", async () => {
		const dgHome = freshDgHome();
		const daemon = await bootOn(dgHome, {
			services: { a: sleeper(dgHome), b: sleeper(dgHome) },
		});
		const backup = join(daemon.paths.daemonDir, "config.json.pre-jobs");
		const log = await waitForValue(
			() => {
				const text = readDaemonLog(dgHome);
				return text.includes("service(s) to") ? text : undefined;
			},
			8000,
			"the moved log line",
		);
		const rows = log
			.split("\n")
			.filter((line) => line.includes("service(s) to"));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toContain(`moved 2 service(s) to "jobs"; backup ${backup}`);
		expect(rows[0]).not.toContain("SECRET-ARG");
	}, 20_000);

	it("leaves an autostart value that is not a boolean in place, and the entry is invalid", async () => {
		const dgHome = freshDgHome();
		const daemon = await bootOn(dgHome, {
			services: { a: sleeper(dgHome, { autostart: "yes" }) },
		});
		expect(configOf(daemon).jobs.a.autostart).toBe("yes");
		const [row] = await listJobs(daemon);
		expect(row).toMatchObject({ label: "a", state: "invalid" });
		expect(row.error).toContain("unknown key(s): autostart");
	}, 20_000);

	it("moves a services key that an old CLI wrote after the mark", async () => {
		const dgHome = freshDgHome();
		const daemon = await bootOn(dgHome, {
			jobsVersion: 1,
			services: { late: sleeper(dgHome) },
		});
		const config = configOf(daemon);
		expect(Object.hasOwn(config, "services")).toBe(false);
		expect(config.jobs.late).toMatchObject({ continuous: true });
	}, 20_000);

	it("keeps a jobsVersion of 5", async () => {
		const dgHome = freshDgHome();
		const daemon = await bootOn(dgHome, { jobsVersion: 5, services: {} });
		expect(configOf(daemon).jobsVersion).toBe(5);
	}, 20_000);

	it("gives the earlier instance conflict for a service whose pid file names a live process", async () => {
		const dgHome = freshDgHome();
		const orphan = Bun.spawn([
			process.execPath,
			"-e",
			"setTimeout(() => {}, 60000)",
		]);
		extraProcs.push(orphan);
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		mkdirSync(join(paths.daemonDir, "services"), { recursive: true });
		writeFileSync(
			join(paths.daemonDir, "services", "bot.pid"),
			String(orphan.pid),
		);
		await bootOn(dgHome, {
			services: { bot: sleeper(dgHome, { autostart: true }) },
		});
		const log = await waitForValue(
			() => {
				const text = readDaemonLog(dgHome);
				return text.includes("an earlier instance") ? text : undefined;
			},
			8000,
			"the earlier instance line",
		);
		expect(log).toContain(
			`an earlier instance (pid ${orphan.pid}) is still running`,
		);
	}, 20_000);
});

describe("daemon boot with no services table", () => {
	it("writes the mark alone on a machine with no config file", async () => {
		const dgHome = freshDgHome();
		const daemon = await bootOn(dgHome);
		const config = configOf(daemon);
		expect(config.jobsVersion).toBe(2);
		expect(Object.hasOwn(config, "jobs")).toBe(false);
		expect(
			existsSync(join(daemon.paths.daemonDir, "config.json.pre-jobs")),
		).toBe(false);
		if (process.platform !== "win32") {
			expect(statSync(daemon.paths.daemonConfigPath).mode & 0o777).toBe(0o600);
		}
	}, 20_000);

	it("writes no file on a second start", async () => {
		const dgHome = freshDgHome();
		const first = await bootOn(dgHome, { services: { a: sleeper(dgHome) } });
		const bytes = readFileSync(first.paths.daemonConfigPath, "utf8");
		const mtime = statSync(first.paths.daemonConfigPath).mtimeMs;
		killDaemonByPidFile(dgHome);
		await waitForDaemonExit(dgHome);
		await bootOn(dgHome);
		expect(readFileSync(first.paths.daemonConfigPath, "utf8")).toBe(bytes);
		expect(statSync(first.paths.daemonConfigPath).mtimeMs).toBe(mtime);
	}, 30_000);
});

describe("daemon boot with a services value that is not an object", () => {
	it("logs the warning once per boot and keeps the file as it is on the second boot", async () => {
		const dgHome = freshDgHome();
		const first = await bootOn(dgHome, { services: [1] });
		const file = first.paths.daemonConfigPath;
		const countWarnings = () =>
			readDaemonLog(dgHome)
				.split("\n")
				.filter(
					(line) =>
						line.includes(file) && line.includes('"services" is not an object'),
				).length;
		await waitForValue(
			() => (countWarnings() === 1 ? true : undefined),
			8000,
			"first warning",
		);
		const bytes = readFileSync(file, "utf8");
		expect(JSON.parse(bytes)).toMatchObject({ jobsVersion: 2, services: [1] });
		killDaemonByPidFile(dgHome);
		await waitForDaemonExit(dgHome);
		await bootOn(dgHome);
		await waitForValue(
			() => (countWarnings() === 2 ? true : undefined),
			8000,
			"second warning",
		);
		expect(readFileSync(file, "utf8")).toBe(bytes);
	}, 30_000);
});

describe("daemon boot with a config that cannot move", () => {
	it("boots on a config that is not valid JSON, writes nothing and logs one warning naming the file", async () => {
		const dgHome = freshDgHome();
		const file = resolveDgPaths({ env: { DG_HOME: dgHome } }).daemonConfigPath;
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, '{"services":');
		await bootOn(dgHome);
		expect(readFileSync(file, "utf8")).toBe('{"services":');
		const rows = readDaemonLog(dgHome)
			.split("\n")
			.filter((line) => line.includes(file));
		expect(rows).toHaveLength(1);
	}, 20_000);

	it("keeps a name that is in both tables, writes nothing and still boots", async () => {
		const dgHome = freshDgHome();
		const body = JSON.stringify({
			jobs: { a: sleeper(dgHome, { continuous: true }) },
			services: { a: sleeper(dgHome) },
		});
		const file = resolveDgPaths({ env: { DG_HOME: dgHome } }).daemonConfigPath;
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, body);
		await bootOn(dgHome);
		expect(readFileSync(file, "utf8")).toBe(body);
		expect(readDaemonLog(dgHome)).toContain(
			'"a" is in "services" and in "jobs"',
		);
	}, 20_000);
});
