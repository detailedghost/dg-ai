import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	CHAT_PROTOCOL_VERSION,
	CHAT_SERVICES_PATH,
	type DaemonHandle,
	DgCliError,
	EXIT_LAYOUT_BLOCKED,
	EXIT_WSL_NAT_NETWORKING,
} from "@dg/common";
import {
	type AutostartDeps,
	type AutostartKind,
	type AutostartSpec,
	type DgPaths,
	ensureOwnerToken,
	installAutostart,
	launchdPlistPath,
	readPidFile,
	resolveDgPaths,
	systemdUnitPath,
	windowsTaskXmlPath,
	writePidFileAtomic,
} from "@dg/common/node";
import { assertNotBlocked } from "@dg/common/node/layout";
import { launcherCommand } from "@dg/common/node/program";
import { cmdStart, startedLine } from "../../src/commands/start";
import { cmdRestart, cmdStop } from "../../src/commands/stop";
import { allocatePort, waitForDaemonExit } from "../utils/daemon-harness";

const TIMEOUT_TEXT = "dg-daemon did not become healthy within the startup timeout";
const OLD_PID = 424242;
const LABEL = "com.detailedghost.dg-daemon";

type Reply = { code: number; stderr?: string };

let root: string;
let paths: DgPaths;
let events: string[];
let replies: (argv: string[]) => Reply;
let cleanups: (() => void)[];
let alive: Set<number>;
let spawned: string[];
let onManagerStart: (argv: string[]) => boolean;
const saved: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined): void {
	if (!(key in saved)) saved[key] = process.env[key];
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "dg-managed-"));
	setEnv("DG_HOME", join(root, "dg"));
	setEnv("DG_PORT", String(allocatePort()));
	setEnv("DG_KEY_SOURCE", "file");
	setEnv("WSL_DISTRO_NAME", undefined);
	setEnv("DG_WSL_NETWORKING_MODE", undefined);
	paths = resolveDgPaths();
	events = [];
	cleanups = [];
	alive = new Set();
	spawned = [];
	replies = () => ({ code: 0 });
	onManagerStart = () => false;
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	const leftover = readPidFile(paths);
	if (leftover && leftover.pid !== process.pid && leftover.pid !== OLD_PID) {
		try {
			process.kill(leftover.pid, "SIGTERM");
		} catch {}
		await waitForDaemonExit(paths.legacyHome).catch(() => {});
	}
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
});

function newHandle(pid: number): DaemonHandle {
	const instanceId = crypto.randomUUID();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			const path = new URL(req.url).pathname;
			if (path === CHAT_SERVICES_PATH) return Response.json({ instanceId, services: [] });
			return Response.json({ instanceId });
		},
	});
	cleanups.push(() => server.stop(true));
	const handle: DaemonHandle = {
		pid,
		port: server.port as number,
		instanceId,
		versions: { package: "9.9.9", protocol: CHAT_PROTOCOL_VERSION },
	};
	ensureOwnerToken(paths);
	writePidFileAtomic(paths, handle);
	return handle;
}

function liveOldDaemon(): DaemonHandle {
	alive.add(OLD_PID);
	return newHandle(OLD_PID);
}

function makeDeps(platform: NodeJS.Platform, env: Record<string, string | undefined>): AutostartDeps {
	return {
		platform,
		homeDir: join(root, "home"),
		env,
		uid: 501,
		writeFile: (path, data) => {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, data);
		},
		removeFile: (path) => rmSync(path, { force: true }),
		fileExists: existsSync,
		run: async (argv) => {
			events.push(`run ${argv.join(" ")}`);
			if (onManagerStart(argv)) newHandle(process.pid);
			const reply = replies(argv);
			return { code: reply.code, stdout: "", stderr: reply.stderr ?? "" };
		},
	};
}

const specFor = (dgHome: string | undefined): AutostartSpec => ({
	name: "dg-daemon",
	argv: launcherCommand(paths.dataDir, "dg-daemon", ["serve"]),
	dgHome,
	logPath: join(paths.logDir, "dg-daemon-autostart.log"),
	restartPreventExitStatus: [EXIT_WSL_NAT_NETWORKING, EXIT_LAYOUT_BLOCKED],
});

type Scenario = { deps: AutostartDeps; kind: AutostartKind; startCommands: string[]; unitPath: string };

async function withUnit(kind: AutostartKind, callerEnv?: Record<string, string>): Promise<Scenario> {
	const platform = kind === "systemd" ? "linux" : kind === "launchd" ? "darwin" : "win32";
	const env = callerEnv ?? (kind === "task" ? {} : { DG_HOME: paths.legacyHome });
	const deps = makeDeps(platform, env);
	const wasReplies = replies;
	replies = () => ({ code: 0 });
	await installAutostart(deps, paths, specFor(env.DG_HOME));
	replies = wasReplies;
	events.length = 0;
	const plist = launchdPlistPath(deps.homeDir, "dg-daemon");
	const startCommands =
		kind === "systemd"
			? ["systemctl --user restart dg-daemon.service"]
			: kind === "launchd"
				? [`launchctl bootstrap gui/501 ${plist}`, `launchctl kickstart -k gui/501/${LABEL}`]
				: ["schtasks /End /TN dg-daemon", "schtasks /Run /TN dg-daemon"];
	const unitPath =
		kind === "systemd"
			? systemdUnitPath(deps.homeDir, deps.env, "dg-daemon")
			: kind === "launchd"
				? plist
				: windowsTaskXmlPath(paths, "dg-daemon");
	onManagerStart = (argv) => {
		const line = argv.join(" ");
		return line === startCommands[startCommands.length - 1];
	};
	return { deps, kind, startCommands, unitPath };
}

function captureLines(): () => string[] {
	const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		events.push(`say ${args.join(" ")}`);
	});
	cleanups.push(() => spy.mockRestore());
	return () => events.filter((event) => event.startsWith("say ")).map((event) => event.slice(4));
}

const runs = (): string[] => events.filter((event) => event.startsWith("run ")).map((event) => event.slice(4));

function stopSeams(deps: AutostartDeps, extra: Record<string, unknown> = {}) {
	const kill = (pid: number, signal: NodeJS.Signals | 0): void => {
		events.push(`kill ${pid} ${signal}`);
		if (!alive.has(Math.abs(pid))) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
		if (signal !== 0) alive.delete(Math.abs(pid));
	};
	const exec = (command: string, args: string[]): void => {
		events.push(`exec ${[command, ...args].join(" ")}`);
		alive.delete(Number(args[args.length - 1]));
	};
	return { platform: deps.platform, kill, exec, waitMs: 2000, autostart: deps, ...extra } as NonNullable<
		Parameters<typeof cmdStop>[1]
	>;
}

function startSeams(deps: AutostartDeps, timeoutMs = 3000) {
	const spawn = ((command: string) => {
		spawned.push(command);
		newHandle(process.pid);
		return { unref: () => {} };
	}) as never;
	return { autostart: deps, timeoutMs, spawn } as NonNullable<Parameters<typeof cmdStart>[1]>;
}

const liveHandle = (): DaemonHandle => readPidFile(paths) as DaemonHandle;
const livePid = (): number => liveHandle().pid;
const failure = async (action: Promise<unknown>): Promise<DgCliError> => {
	const error = await action.then(
		() => undefined,
		(err: unknown) => err,
	);
	expect(error).toBeInstanceOf(DgCliError);
	return error as DgCliError;
};

const indexAfter = (from: number, prefix: string): number => events.findIndex((event, i) => i > from && event.startsWith(prefix));

describe("dg-daemon start with a login unit", () => {
	it("runs the manager restart one time, spawns nothing, and prints the started line", async () => {
		const scenario = await withUnit("systemd");
		const lines = captureLines();

		await cmdStart({}, startSeams(scenario.deps));

		expect(runs()).toEqual(scenario.startCommands);
		expect(spawned).toEqual([]);
		const handle = liveHandle();
		expect(lines()).toEqual([startedLine(handle, true)]);
	});

	it("keeps the keys of master in the --json line", async () => {
		const scenario = await withUnit("systemd");
		const lines = captureLines();

		await cmdStart({ json: true }, startSeams(scenario.deps));

		const handle = liveHandle();
		expect(JSON.parse(lines()[0] as string)).toEqual({
			started: true,
			pid: handle.pid,
			port: handle.port,
			version: handle.versions.package,
		});
	});

	it("runs no manager command and prints already running for a live daemon", async () => {
		const scenario = await withUnit("systemd");
		const handle = newHandle(process.pid);
		const lines = captureLines();

		await cmdStart({}, startSeams(scenario.deps));

		expect(runs()).toEqual([]);
		expect(lines()).toEqual([startedLine(handle, false)]);
	});

	for (const kind of ["launchd", "task"] as const) {
		it(`runs the managed start commands of ${kind} in order`, async () => {
			const scenario = await withUnit(kind);
			captureLines();

			await cmdStart({}, startSeams(scenario.deps));

			expect(runs()).toEqual(scenario.startCommands);
			expect(spawned).toEqual([]);
		});
	}

	it("goes on with the next manager command when one exits with a code other than 0", async () => {
		const scenario = await withUnit("task");
		replies = (argv) => (argv[1] === "/End" ? { code: 1, stderr: "not running" } : { code: 0 });
		captureLines();

		await cmdStart({}, startSeams(scenario.deps));

		expect(runs()).toEqual(scenario.startCommands);
	});

	it("exits 1 with the startup timeout text when no daemon is live after the commands", async () => {
		const scenario = await withUnit("systemd");
		onManagerStart = () => false;

		const error = await failure(cmdStart({}, startSeams(scenario.deps, 300)));

		expect(error.exitCode).toBe(1);
		expect(error.message).toBe(TIMEOUT_TEXT);
	});

	it("names the failed manager command in the timeout text", async () => {
		const scenario = await withUnit("systemd");
		onManagerStart = () => false;
		replies = () => ({ code: 5, stderr: "Unit dg-daemon.service not found.\nmore" });

		const error = await failure(cmdStart({}, startSeams(scenario.deps, 300)));

		expect(error.exitCode).toBe(1);
		expect(error.message).toBe(
			`${TIMEOUT_TEXT} (systemctl --user restart dg-daemon.service failed: Unit dg-daemon.service not found.)`,
		);
	});

	it("names a failed /End in the timeout text", async () => {
		const scenario = await withUnit("task");
		onManagerStart = () => false;
		replies = (argv) => (argv[1] === "/End" ? { code: 1, stderr: "not running" } : { code: 0 });

		const error = await failure(cmdStart({}, startSeams(scenario.deps, 300)));

		expect(error.message).toBe(`${TIMEOUT_TEXT} (schtasks /End /TN dg-daemon failed: not running)`);
	});

	it("names the failed /Run, not the earlier failed /End, in the timeout text", async () => {
		const scenario = await withUnit("task");
		onManagerStart = () => false;
		replies = (argv) =>
			argv[1] === "/End" ? { code: 1, stderr: "not running" } : { code: 1, stderr: "access denied" };

		const error = await failure(cmdStart({}, startSeams(scenario.deps, 300)));

		expect(error.message).toBe(`${TIMEOUT_TEXT} (schtasks /Run /TN dg-daemon failed: access denied)`);
	});

	it("exits 3 with no manager command in WSL NAT mode", async () => {
		const scenario = await withUnit("systemd");
		setEnv("WSL_DISTRO_NAME", "Ubuntu");
		setEnv("DG_WSL_NETWORKING_MODE", "nat");

		const error = await failure(cmdStart({}, startSeams(scenario.deps)));

		expect(error.exitCode).toBe(EXIT_WSL_NAT_NETWORKING);
		expect(runs()).toEqual([]);
	});

	it("starts as on master, with no manager command, when the unit records another DG_HOME", async () => {
		const scenario = await withUnit("systemd", { DG_HOME: "/a" });
		captureLines();

		await cmdStart({}, startSeams({ ...scenario.deps, env: { DG_HOME: paths.legacyHome } }));

		expect(runs()).toEqual([]);
		expect(livePid()).toBeGreaterThan(0);
	});

	it("starts as on master when the unit records another XDG_DATA_HOME than the caller", async () => {
		const scenario = await withUnit("systemd", { DG_HOME: paths.legacyHome, XDG_DATA_HOME: "/x" });
		captureLines();

		await cmdStart({}, startSeams({ ...scenario.deps, env: { DG_HOME: paths.legacyHome } }));

		expect(runs()).toEqual([]);
	});

	it("runs the manager command when the unit records the XDG_DATA_HOME of the caller", async () => {
		const env = { DG_HOME: paths.legacyHome, XDG_DATA_HOME: "/x" };
		const scenario = await withUnit("systemd", env);
		captureLines();

		await cmdStart({}, startSeams(scenario.deps));

		expect(runs()).toEqual(scenario.startCommands);
	});

	it("starts as on master with no manager command when no login unit exists", async () => {
		captureLines();

		await cmdStart({}, startSeams(makeDeps("linux", { DG_HOME: paths.legacyHome })));

		expect(runs()).toEqual([]);
		expect(livePid()).toBeGreaterThan(0);
	});

	it("prints the block text and runs no manager command and no spawn when the daemon entry is blocked", async () => {
		const scenario = await withUnit("systemd");
		const from = join(paths.legacyHome, "daemon");
		mkdirSync(from, { recursive: true });
		writeFileSync(join(from, "key"), "k");
		const expected = await failure(Promise.resolve().then(() => assertNotBlocked(paths, "daemon")));
		const startedAt = Date.now();

		const error = await failure(cmdStart({}, startSeams(scenario.deps, 10_000)));

		expect(error.message).toBe(expected.message);
		expect(error.exitCode).toBe(expected.exitCode);
		expect(runs()).toEqual([]);
		expect(spawned).toEqual([]);
		expect(Date.now() - startedAt).toBeLessThan(2000);
	});
});

describe("dg-daemon restart with a login unit", () => {
	it("stops the daemon with SIGTERM and the wait, then runs the manager command, and prints two lines", async () => {
		const scenario = await withUnit("systemd");
		liveOldDaemon();
		const lines = captureLines();

		await cmdRestart({}, stopSeams(scenario.deps));

		const term = events.indexOf(`kill ${OLD_PID} SIGTERM`);
		const manager = events.indexOf(`run ${scenario.startCommands[0]}`);
		expect(term).toBeGreaterThanOrEqual(0);
		expect(indexAfter(term, `kill ${OLD_PID} 0`)).toBeGreaterThan(term);
		expect(indexAfter(term, `kill ${OLD_PID} 0`)).toBeLessThan(manager);
		expect(runs()).toEqual(scenario.startCommands);
		expect(spawned).toEqual([]);
		expect(lines()).toEqual([`dg-daemon stopped (pid ${OLD_PID})`, startedLine(liveHandle(), true)]);
	});

	it("does the force stop of master, then the manager command, with --force", async () => {
		const scenario = await withUnit("systemd");
		liveOldDaemon();
		captureLines();

		await cmdRestart({ force: true }, stopSeams(scenario.deps));

		const kill = events.indexOf(`kill ${OLD_PID} SIGKILL`);
		const manager = events.indexOf(`run ${scenario.startCommands[0]}`);
		expect(kill).toBeGreaterThanOrEqual(0);
		expect(manager).toBeGreaterThan(kill);
		expect(events.filter((event) => event.startsWith("run ")).pop()).toBe(`run ${scenario.startCommands[0]}`);
	});

	it("sends no signal and runs the managed start commands one time when no daemon is live", async () => {
		const scenario = await withUnit("systemd");
		captureLines();

		await cmdRestart({}, stopSeams(scenario.deps));

		expect(events.some((event) => /^kill \d+ SIG/.test(event))).toBe(false);
		expect(runs()).toEqual(scenario.startCommands);
	});

	it("runs no manager command when no login unit exists", async () => {
		liveOldDaemon();
		captureLines();

		await cmdRestart({}, stopSeams(makeDeps("linux", { DG_HOME: paths.legacyHome }), { spawn: undefined }));

		expect(runs()).toEqual([]);
	});

	it("exits 3 with no manager command in WSL NAT mode", async () => {
		const scenario = await withUnit("systemd");
		setEnv("WSL_DISTRO_NAME", "Ubuntu");
		setEnv("DG_WSL_NETWORKING_MODE", "nat");

		const error = await failure(cmdRestart({}, stopSeams(scenario.deps)));

		expect(error.exitCode).toBe(EXIT_WSL_NAT_NETWORKING);
		expect(runs()).toEqual([]);
	});

	it("prints the block text and runs no manager command when the daemon entry is blocked", async () => {
		const scenario = await withUnit("systemd");
		const from = join(paths.legacyHome, "daemon");
		mkdirSync(from, { recursive: true });
		writeFileSync(join(from, "key"), "k");
		const expected = await failure(Promise.resolve().then(() => assertNotBlocked(paths, "daemon")));

		const error = await failure(cmdRestart({}, stopSeams(scenario.deps)));

		expect(error.message).toBe(expected.message);
		expect(runs()).toEqual([]);
	});
});

describe("dg-daemon stop with a login unit", () => {
	it("on POSIX a regular stop sends SIGTERM and runs no manager command", async () => {
		for (const kind of ["systemd", "launchd"] as const) {
			events.length = 0;
			const scenario = await withUnit(kind);
			liveOldDaemon();
			captureLines();

			await cmdStop({}, stopSeams(scenario.deps));

			expect(events).toContain(`kill ${OLD_PID} SIGTERM`);
			expect(runs()).toEqual([]);
		}
	});

	it("systemd --force kills, then stops the unit, then waits, and keeps the unit file", async () => {
		const scenario = await withUnit("systemd");
		liveOldDaemon();
		captureLines();

		await cmdStop({ force: true }, stopSeams(scenario.deps));

		const kill = events.indexOf(`kill ${OLD_PID} SIGKILL`);
		const stop = events.indexOf("run systemctl --user stop dg-daemon.service");
		expect(kill).toBeGreaterThanOrEqual(0);
		expect(stop).toBeGreaterThan(kill);
		expect(indexAfter(stop, `kill ${OLD_PID} 0`)).toBeGreaterThan(stop);
		expect(runs()).toEqual(["systemctl --user stop dg-daemon.service"]);
		expect(existsSync(scenario.unitPath)).toBe(true);
	});

	it("launchd --force kills, then boots the label out, and keeps the plist", async () => {
		const scenario = await withUnit("launchd");
		liveOldDaemon();
		captureLines();

		await cmdStop({ force: true }, stopSeams(scenario.deps));

		const kill = events.indexOf(`kill ${OLD_PID} SIGKILL`);
		const bootout = events.indexOf(`run launchctl bootout gui/501/${LABEL}`);
		expect(kill).toBeGreaterThanOrEqual(0);
		expect(bootout).toBeGreaterThan(kill);
		expect(runs()).toEqual([`launchctl bootout gui/501/${LABEL}`]);
		expect(existsSync(scenario.unitPath)).toBe(true);
	});

	it("win32 --force ends the task one time before the taskkill and keeps the task XML", async () => {
		const scenario = await withUnit("task");
		liveOldDaemon();
		captureLines();

		await cmdStop({ force: true }, stopSeams(scenario.deps));

		const end = events.indexOf("run schtasks /End /TN dg-daemon");
		const kill = events.indexOf(`exec taskkill /F /PID ${OLD_PID}`);
		expect(end).toBeGreaterThanOrEqual(0);
		expect(kill).toBeGreaterThan(end);
		expect(runs()).toEqual(["schtasks /End /TN dg-daemon"]);
		expect(existsSync(scenario.unitPath)).toBe(true);
	});

	it("win32 regular stop also ends the task one time, then kills", async () => {
		const scenario = await withUnit("task");
		liveOldDaemon();
		captureLines();

		await cmdStop({}, stopSeams(scenario.deps));

		const end = events.indexOf("run schtasks /End /TN dg-daemon");
		const kill = events.indexOf(`exec taskkill /F /PID ${OLD_PID}`);
		expect(end).toBeGreaterThanOrEqual(0);
		expect(kill).toBeGreaterThan(end);
		expect(runs()).toEqual(["schtasks /End /TN dg-daemon"]);
	});

	it("runs no manager command when the unit records another DG_HOME", async () => {
		const scenario = await withUnit("systemd", { DG_HOME: "/a" });
		liveOldDaemon();
		captureLines();

		await cmdStop({ force: true }, stopSeams({ ...scenario.deps, env: { DG_HOME: paths.legacyHome } }));

		expect(runs()).toEqual([]);
	});

	it("runs no manager command when no login unit exists, on any platform", async () => {
		for (const platform of ["linux", "darwin", "win32"] as const) {
			events.length = 0;
			liveOldDaemon();
			captureLines();

			await cmdStop({ force: platform !== "win32" }, stopSeams(makeDeps(platform, {})));

			expect(runs()).toEqual([]);
		}
	});

	for (const kind of ["systemd", "launchd", "task"] as const) {
		it(`start after stop --force goes through the ${kind} manager and spawns nothing`, async () => {
			const scenario = await withUnit(kind);
			liveOldDaemon();
			captureLines();
			await cmdStop({ force: true }, stopSeams(scenario.deps));
			events.length = 0;

			await cmdStart({}, startSeams(scenario.deps));

			expect(runs()).toEqual(scenario.startCommands);
			expect(spawned).toEqual([]);
		});
	}
});
