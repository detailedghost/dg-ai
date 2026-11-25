import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
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
} from "../utils/daemon-harness";
import { configPathOf, writeConfigFile } from "../utils/service-daemon";
import { runCli } from "./service-cli-helpers";

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

const add = (
	dgHome: string,
	port: number,
	name: string,
	flags: string[],
	command = ["bun", "run", "bot.ts"],
) =>
	runCli(
		dgHome,
		["job", "add", "--name", name, "--continuous", ...flags, "--", ...command],
		{ port },
	);

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

	it("fails with the not migrated text, the start error and exit code 1 when the daemon start throws", async () => {
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
		expect((failure as DgCliError).message).toBe(`${NOT_MIGRATED} (spawn refused)`);
		expect((failure as DgCliError).exitCode).toBe(1);
	});

	it("returns at once on a config that has the mark", async () => {
		const { dgHome } = setup();
		writeConfigFile(dgHome, { jobsVersion: 2 });
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

describe("job add against a live daemon that left no mark", () => {
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
			["job", "add", "--name", "x", "--continuous", "--cwd", cwd, "--", "bun", "run", "bot.ts"],
			{ port: boot.port },
		);
		expect(Date.now() - started).toBeLessThan(25_000);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			`the daemon config is not migrated — a dg daemon from before this release runs (pid ${before.pid}); run dg daemon restart, then run this command again`,
		);
		expect(readFileSync(configPathOf(boot.dgHome), "utf8")).toBe(body);
		expect(readPidFile(boot.dgHome)).toEqual(before);
		expect(() => process.kill(before.pid, 0)).not.toThrow();
	}, 45_000);
});

describe("job add against a live daemon of this release that cannot write the mark", () => {
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
			`the daemon config is not migrated — the dg daemon (pid ${pid}) did not write the mark; see the daemon log`,
		);
		expect(result.stderr).not.toContain("from before this release");
		expect(readFileSync(configPathOf(dgHome), "utf8")).toBe(body);
	}, 45_000);
});

describe("job add that starts a daemon which never writes the mark", () => {
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
