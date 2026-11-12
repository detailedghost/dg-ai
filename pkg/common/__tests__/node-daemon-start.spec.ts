import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CHAT_PROTOCOL_VERSION,
	DgCliError,
	EXIT_GENERAL_FAILURE,
	EXIT_WSL_NAT_NETWORKING,
	type DaemonHandle,
} from "../src";
import { ensureDaemonRunning } from "../src/node/daemon-start";
import { resolveDgPaths, writePidFileAtomic, type DgPaths } from "../src/node";
import { setProgramName } from "../src/node/program";

const TIMEOUT_TEXT = "dg-daemon did not become healthy within the startup timeout";

type Fake = { handle: DaemonHandle; stop: () => void };

function fakeDaemon(overrides: Partial<DaemonHandle> = {}): Fake {
	const instanceId = crypto.randomUUID();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => Response.json({ instanceId }),
	});
	const handle: DaemonHandle = {
		pid: process.pid,
		port: server.port as number,
		instanceId,
		versions: { package: "9.9.9", protocol: CHAT_PROTOCOL_VERSION },
		...overrides,
	};
	return { handle, stop: () => server.stop(true) };
}

type SpawnCall = { command: string; args: string[]; options: Record<string, unknown> };

function recordingSpawn(onSpawn: () => void = () => {}) {
	const calls: SpawnCall[] = [];
	let unrefs = 0;
	const spawn = ((command: string, args: string[], options: Record<string, unknown>) => {
		calls.push({ command, args, options });
		onSpawn();
		return { unref: () => void unrefs++ };
	}) as never;
	return { calls, spawn, unrefs: () => unrefs };
}

describe("ensureDaemonRunning", () => {
	let dgHome: string;
	let paths: DgPaths;
	const fakes: Fake[] = [];
	const savedEnv: Record<string, string | undefined> = {};

	const setEnv = (key: string, value: string | undefined) => {
		if (!(key in savedEnv)) savedEnv[key] = process.env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	};

	beforeEach(() => {
		dgHome = mkdtempSync(join(tmpdir(), "dg-daemon-start-"));
		paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		setEnv("WSL_DISTRO_NAME", undefined);
		setEnv("DG_WSL_NETWORKING_MODE", undefined);
	});

	afterEach(() => {
		setProgramName(undefined);
		for (const fake of fakes.splice(0)) fake.stop();
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(dgHome, { recursive: true, force: true });
	});

	const live = (overrides: Partial<DaemonHandle> = {}) => {
		const fake = fakeDaemon(overrides);
		fakes.push(fake);
		writePidFileAtomic(paths, fake.handle);
		return fake;
	};

	it("returns the live daemon with started false and spawns nothing", async () => {
		const fake = live();
		const { calls, spawn } = recordingSpawn();

		const result = await ensureDaemonRunning(paths, { spawn });

		expect(result.started).toBe(false);
		expect(result.handle).toEqual(fake.handle);
		expect(calls).toEqual([]);
	});

	it("accepts undefined seam values as the defaults", async () => {
		const fake = live();

		const result = await ensureDaemonRunning(paths, {
			daemonArgv: undefined,
			spawn: undefined,
			timeoutMs: undefined,
		});

		expect(result).toEqual({ handle: fake.handle, started: false });
	});

	it("spawns the argv of the daemonArgv seam with the detached options when no daemon is live", async () => {
		const argv = ["/opt/dg/bun", "/opt/dg/dg.js", "dg-daemon", "__serve"];
		const recorder = recordingSpawn(() => live());

		const result = await ensureDaemonRunning(paths, {
			daemonArgv: () => argv,
			spawn: recorder.spawn,
		});

		expect(result.started).toBe(true);
		expect(recorder.calls).toHaveLength(1);
		const [call] = recorder.calls;
		expect([call.command, ...call.args]).toEqual(argv);
		expect(call.options).toEqual({
			detached: true,
			stdio: "ignore",
			windowsHide: process.platform === "win32",
			env: process.env,
		});
		expect(recorder.unrefs()).toBe(1);
	});

	it("spawns after a pid file that names a dead daemon", async () => {
		const dead = fakeDaemon();
		dead.stop();
		writePidFileAtomic(paths, dead.handle);
		const recorder = recordingSpawn(() => live());

		const result = await ensureDaemonRunning(paths, {
			daemonArgv: () => ["x"],
			spawn: recorder.spawn,
		});

		expect(result.started).toBe(true);
		expect(result.handle.instanceId).not.toBe(dead.handle.instanceId);
	});

	it("spawns [execPath, Bun.main, dg-daemon, __serve] in bundle mode", async () => {
		setProgramName("dg-agent");
		const recorder = recordingSpawn(() => live());

		await ensureDaemonRunning(paths, { spawn: recorder.spawn });

		const [call] = recorder.calls;
		expect([call.command, ...call.args]).toEqual([
			process.execPath,
			Bun.main,
			"dg-daemon",
			"__serve",
		]);
	});

	it("rejects with the startup timeout error when the spawned program exits at once", async () => {
		const failure = await ensureDaemonRunning(paths, {
			daemonArgv: () => [process.execPath, "-e", ""],
			timeoutMs: 300,
		}).catch((err: unknown) => err);

		expect(failure).toBeInstanceOf(DgCliError);
		expect((failure as DgCliError).message).toBe(TIMEOUT_TEXT);
		expect((failure as DgCliError).exitCode).toBe(EXIT_GENERAL_FAILURE);
	});

	it("refuses on WSL NAT networking before it spawns or writes a pid file", async () => {
		setEnv("WSL_DISTRO_NAME", "Ubuntu");
		setEnv("DG_WSL_NETWORKING_MODE", "nat");
		const { calls, spawn } = recordingSpawn();

		const failure = await ensureDaemonRunning(paths, { spawn }).catch(
			(err: unknown) => err,
		);

		expect(failure).toBeInstanceOf(DgCliError);
		expect((failure as DgCliError).exitCode).toBe(EXIT_WSL_NAT_NETWORKING);
		expect((failure as DgCliError).message).toContain(".wslconfig");
		expect(calls).toEqual([]);
		expect(existsSync(paths.pidPath)).toBe(false);
	});

	it("does not check WSL networking when a daemon is already live", async () => {
		const fake = live();
		setEnv("WSL_DISTRO_NAME", "Ubuntu");
		setEnv("DG_WSL_NETWORKING_MODE", "nat");

		const result = await ensureDaemonRunning(paths, {});

		expect(result.handle).toEqual(fake.handle);
		expect(result.started).toBe(false);
	});
});
