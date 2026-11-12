import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	CHAT_PROTOCOL_VERSION,
	CHAT_SERVICES_PATH,
	type DaemonHandle,
	DgCliError,
	OWNER_TOKEN_HEADER,
} from "@dg/common";
import {
	type DgPaths,
	ensureOwnerToken,
	resolveDgPaths,
	writePidFileAtomic,
} from "@dg/common/node";
import { cmdRestart, cmdStop } from "../../src/commands/stop";
import {
	allocatePort,
	bootServe,
	cleanupDgHome,
	ENTRY,
	freshDgHome,
	killDaemonByPidFile,
	ownerTokenHeader,
	readPidFile,
	subprocessEnv,
	waitForDaemonExit,
	waitForHealth,
} from "../utils/daemon-harness";

type RunResult = { code: number; stdout: string; stderr: string };

async function dg(
	dgHome: string,
	port: number,
	args: string[],
	extraEnv: Record<string, string> = {},
): Promise<RunResult> {
	const proc = Bun.spawn([process.execPath, ENTRY, ...args], {
		env: subprocessEnv(dgHome, port, extraEnv),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stdout, stderr };
}

const cleanups: (() => Promise<void> | void)[] = [];
const savedEnv: Record<string, string | undefined> = {};

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}, 30_000);

function setEnv(key: string, value: string): void {
	if (!(key in savedEnv)) savedEnv[key] = process.env[key];
	process.env[key] = value;
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function until(
	check: () => boolean | Promise<boolean>,
	ms = 5000,
): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (await check()) return;
		await Bun.sleep(50);
	}
	throw new Error("condition did not hold in time");
}

async function healthzUp(port: number): Promise<boolean> {
	try {
		return (await fetch(`http://127.0.0.1:${port}/healthz`)).ok;
	} catch {
		return false;
	}
}

function homeWithPort() {
	const dgHome = freshDgHome();
	const port = allocatePort();
	cleanups.push(async () => {
		killDaemonByPidFile(dgHome);
		await waitForDaemonExit(dgHome).catch(() => {});
		cleanupDgHome(dgHome);
	});
	return { dgHome, port };
}

const handleFor = (overrides: Partial<DaemonHandle>): DaemonHandle => ({
	pid: process.pid,
	port: 0,
	instanceId: crypto.randomUUID(),
	versions: { package: "9.9.9", protocol: CHAT_PROTOCOL_VERSION },
	...overrides,
});

const LONG_SERVICE = (stopTimeoutMs: number, autostart: boolean) => ({
	argv: [
		process.execPath,
		"-e",
		"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",
	],
	cwd: process.cwd(),
	stopTimeoutMs,
	...(autostart ? { autostart: true } : {}),
});

function declareServices(
	paths: DgPaths,
	services: Record<string, unknown>,
): void {
	mkdirSync(dirname(paths.daemonConfigPath), { recursive: true });
	writeFileSync(paths.daemonConfigPath, JSON.stringify({ services }));
}

type Listed = { label: string; state: string; pid: number | null };

async function listServices(port: number, dgHome: string): Promise<Listed[]> {
	const resp = await fetch(`http://127.0.0.1:${port}${CHAT_SERVICES_PATH}`, {
		headers: { Host: `127.0.0.1:${port}`, ...ownerHeaders(dgHome) },
	});
	return ((await resp.json()) as { services: Listed[] }).services;
}

function ownerHeaders(dgHome: string): Record<string, string> {
	const token = readFileSync(
		`${resolveDgPaths({ env: { DG_HOME: dgHome } }).daemonDir}/owner.token`,
		"utf8",
	).trim();
	return { [OWNER_TOKEN_HEADER]: token };
}

async function startServiceViaHttp(
	port: number,
	label: string,
	dgHome?: string,
): Promise<void> {
	const resp = await fetch(
		`http://127.0.0.1:${port}${CHAT_SERVICES_PATH}/${label}/start`,
		{
			method: "POST",
			headers: {
				Host: `127.0.0.1:${port}`,
				...(dgHome === undefined
					? ownerTokenHeader(port)
					: ownerHeaders(dgHome)),
			},
		},
	);
	expect(resp.status).toBe(200);
}

const STOPPED = /^dg-daemon stopped \(pid (\d+)\)\n$/;
const STARTED =
	/^dg-daemon started on 127\.0\.0\.1:(\d+) \(pid (\d+), version \S+\)\n$/;

describe("dg-daemon stop", () => {
	it("stops a real daemon: pid gone, pid file gone, healthz silent", async () => {
		const { dgHome, port } = homeWithPort();
		await dg(dgHome, port, ["start"]);
		const { pid } = readPidFile(dgHome);

		const result = await dg(dgHome, port, ["stop"]);

		expect(result.code).toBe(0);
		expect(result.stdout).toMatch(STOPPED);
		expect(result.stdout).toBe(`dg-daemon stopped (pid ${pid})\n`);
		expect(pidAlive(pid)).toBe(false);
		expect(
			existsSync(resolveDgPaths({ env: { DG_HOME: dgHome } }).pidPath),
		).toBe(false);
		expect(await healthzUp(port)).toBe(false);
	});

	it("exits 0 and reports no live daemon when none runs", async () => {
		const { dgHome, port } = homeWithPort();

		const result = await dg(dgHome, port, ["stop"]);

		expect(result.code).toBe(0);
		expect(result.stdout).toBe("dg-daemon: no live daemon\n");
	});

	it("removes the pid file of a dead daemon and says so", async () => {
		const { dgHome, port } = homeWithPort();
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		writePidFileAtomic(
			paths,
			handleFor({ pid: 2_147_483_000, port: allocatePort() }),
		);

		const result = await dg(dgHome, port, ["stop"]);

		expect(result.code).toBe(0);
		expect(result.stdout).toBe(
			"dg-daemon: no live daemon (stale pid file removed)\n",
		);
		expect(existsSync(paths.pidPath)).toBe(false);
	});

	it("kills the daemon and a SIGTERM-proof service at once with --force", async () => {
		const { dgHome, port, proc } = await (async () => {
			const boot = await bootServe();
			cleanups.push(async () => {
				killDaemonByPidFile(boot.dgHome);
				boot.proc.kill("SIGKILL");
				cleanupDgHome(boot.dgHome);
			});
			return boot;
		})();
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		declareServices(paths, { bot: LONG_SERVICE(60_000, false) });
		await startServiceViaHttp(port, "bot");
		const [service] = await listServices(port, dgHome);
		const servicePid = service.pid as number;
		const daemonPid = readPidFile(dgHome).pid;
		expect(pidAlive(servicePid)).toBe(true);

		const startedAt = Date.now();
		const result = await dg(dgHome, port, ["stop", "--force"]);

		expect(result.code).toBe(0);
		expect(result.stdout).toBe(
			`dg-daemon stopped (pid ${daemonPid}, forced)\n`,
		);
		expect(Date.now() - startedAt).toBeLessThan(5000);
		await until(() => !pidAlive(daemonPid) && !pidAlive(servicePid), 1000);
		expect(existsSync(paths.pidPath)).toBe(false);
		await proc.exited;
	});

	it("kills the daemon, exits 1 and names the failure when GET /services answers 500", async () => {
		const { dgHome, port } = homeWithPort();
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		const instanceId = crypto.randomUUID();
		const fake = Bun.spawn(
			[
				process.execPath,
				"-e",
				`Bun.serve({hostname:"127.0.0.1",port:Number(process.env.FAKE_PORT),fetch(req){` +
					`if(new URL(req.url).pathname==="/healthz")return Response.json({instanceId:process.env.FAKE_ID});` +
					`return new Response("boom",{status:500})}})`,
			],
			{
				env: { ...process.env, FAKE_PORT: String(port), FAKE_ID: instanceId },
				stdout: "ignore",
				stderr: "ignore",
			},
		);
		cleanups.push(() => void fake.kill("SIGKILL"));
		await waitForHealth(port);
		ensureOwnerToken(paths);
		writePidFileAtomic(paths, handleFor({ pid: fake.pid, port, instanceId }));

		const result = await dg(dgHome, port, ["stop", "--force"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("could not list the services (");
		expect(result.stderr).toContain("); a service process can still run");
		await until(() => !pidAlive(fake.pid), 2000);
	});
});

describe("dg-daemon stop seams", () => {
	function seamHome() {
		const dgHome = freshDgHome();
		cleanups.push(() => cleanupDgHome(dgHome));
		setEnv("DG_HOME", dgHome);
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		return { dgHome, paths };
	}

	function captureStdout() {
		const spy = spyOn(console, "log").mockImplementation(() => {});
		cleanups.push(() => spy.mockRestore());
		return () => spy.mock.calls.map((call) => call.join(" "));
	}

	type Recorded = { pid: number; signal: NodeJS.Signals | 0 }[];

	function fakeProcessTable(alive: number[]) {
		const table = new Set(alive);
		const calls: Recorded = [];
		const execs: { command: string; args: string[] }[] = [];
		const kill = (pid: number, signal: NodeJS.Signals | 0): void => {
			calls.push({ pid, signal });
			const target = Math.abs(pid);
			if (!table.has(target))
				throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
			if (signal !== 0) table.delete(target);
		};
		const exec = (command: string, args: string[]): void => {
			execs.push({ command, args });
			table.delete(Number(args[args.length - 1]));
		};
		const signals = () => calls.filter((call) => call.signal !== 0);
		return { kill, exec, calls, execs, signals };
	}

	type FakeServices = {
		requests: string[];
		daemon: DaemonHandle;
		stop: () => void;
	};

	function fakeDaemonWithServices(
		paths: DgPaths,
		pid: number,
		servicePids: number[],
		servicesInstanceId?: string | null,
	): FakeServices {
		const instanceId = crypto.randomUUID();
		const requests: string[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(req) {
				const path = new URL(req.url).pathname;
				requests.push(`${req.method} ${path}`);
				if (path === "/healthz") return Response.json({ instanceId });
				if (path === CHAT_SERVICES_PATH) {
					return Response.json({
						instanceId:
							servicesInstanceId === null
								? undefined
								: (servicesInstanceId ?? instanceId),
						services: servicePids.map((servicePid, index) => ({
							label: `svc${index}`,
							state: "running",
							pid: servicePid,
						})),
					});
				}
				return new Response("unexpected", { status: 404 });
			},
		});
		const daemon = handleFor({ pid, port: server.port as number, instanceId });
		ensureOwnerToken(paths);
		writePidFileAtomic(paths, daemon);
		cleanups.push(() => server.stop(true));
		return { requests, daemon, stop: () => server.stop(true) };
	}

	it("sends one SIGTERM to the daemon pid and no signal to a service on a regular stop", async () => {
		const { paths } = seamHome();
		const table = fakeProcessTable([424242, 424243]);
		const fake = fakeDaemonWithServices(paths, 424242, [424243]);
		const lines = captureStdout();

		await cmdStop(
			{},
			{ platform: "linux", kill: table.kill, exec: table.exec, waitMs: 2000 },
		);

		expect(table.signals()).toEqual([{ pid: 424242, signal: "SIGTERM" }]);
		expect(lines()).toEqual([`dg-daemon stopped (pid ${fake.daemon.pid})`]);
	});

	it("exits 1 with no SIGKILL and keeps the pid file when the daemon ignores SIGTERM", async () => {
		const { paths } = seamHome();
		const child = Bun.spawn(
			[
				process.execPath,
				"-e",
				"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",
			],
			{ stdout: "ignore", stderr: "ignore" },
		);
		cleanups.push(() => void child.kill("SIGKILL"));
		const instanceId = crypto.randomUUID();
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => Response.json({ instanceId }),
		});
		cleanups.push(() => server.stop(true));
		writePidFileAtomic(
			paths,
			handleFor({ pid: child.pid, port: server.port as number, instanceId }),
		);
		await Bun.sleep(300);
		const recorded: NodeJS.Signals[] = [];
		const kill = (pid: number, signal: NodeJS.Signals | 0) => {
			if (signal !== 0) recorded.push(signal);
			process.kill(pid, signal);
		};

		const failure = await cmdStop({}, { kill, waitMs: 300 }).catch(
			(err: unknown) => err,
		);

		expect(failure).toBeInstanceOf(DgCliError);
		expect((failure as DgCliError).exitCode).toBe(1);
		expect((failure as DgCliError).message).toContain(
			`dg-daemon (pid ${child.pid}) did not stop within`,
		);
		expect((failure as DgCliError).message).toContain(
			"run dg-daemon stop --force",
		);
		expect(recorded).toEqual(["SIGTERM"]);
		expect(pidAlive(child.pid)).toBe(true);
		expect(existsSync(paths.pidPath)).toBe(true);
	});

	it("kills the daemon before the first service, and calls only /healthz and GET /services", async () => {
		const { paths } = seamHome();
		const table = fakeProcessTable([424242, 424243, 424244]);
		const fake = fakeDaemonWithServices(paths, 424242, [424243, 424244]);
		const lines = captureStdout();

		await cmdStop(
			{ force: true },
			{ platform: "linux", kill: table.kill, exec: table.exec, waitMs: 2000 },
		);

		const killed = table.signals().map((call) => Math.abs(call.pid));
		expect(killed[0]).toBe(424242);
		expect(killed).toEqual(expect.arrayContaining([424243, 424244]));
		expect(table.signals().every((call) => call.signal === "SIGKILL")).toBe(
			true,
		);
		expect(new Set(fake.requests)).toEqual(
			new Set(["GET /healthz", "GET /services"]),
		);
		expect(existsSync(paths.pidPath)).toBe(false);
		expect(lines()).toEqual([`dg-daemon stopped (pid 424242, forced)`]);
	});

	function silentPidFile(paths: DgPaths, pid: number): void {
		writePidFileAtomic(paths, handleFor({ pid, port: allocatePort() }));
	}

	it("exits 1, sends no signal and keeps the pid file when the pid runs but healthz does not answer", async () => {
		const { paths } = seamHome();
		const table = fakeProcessTable([424242]);
		silentPidFile(paths, 424242);

		const failure = await cmdStop(
			{},
			{ platform: "linux", kill: table.kill, exec: table.exec, waitMs: 100 },
		).catch((err: unknown) => err);

		expect(failure).toBeInstanceOf(DgCliError);
		expect((failure as DgCliError).exitCode).toBe(1);
		expect((failure as DgCliError).message).toContain(
			"dg-daemon (pid 424242) does not answer",
		);
		expect((failure as DgCliError).message).toContain("dg-daemon stop --force");
		expect(table.signals()).toEqual([]);
		expect(existsSync(paths.pidPath)).toBe(true);
	});

	it("kills a silent daemon with --force when it is identified as our dg-daemon, and warns that a service can run", async () => {
		const { paths } = seamHome();
		const table = fakeProcessTable([424242]);
		silentPidFile(paths, 424242);

		const failure = await cmdStop(
			{ force: true },
			{
				platform: "linux",
				kill: table.kill,
				exec: table.exec,
				waitMs: 2000,
				identify: () => "ours",
			},
		).catch((err: unknown) => err);

		expect(failure).toBeInstanceOf(DgCliError);
		expect((failure as DgCliError).message).toContain(
			"a service process can still run",
		);
		expect(table.signals().map((call) => Math.abs(call.pid))).toEqual([424242]);
		expect(existsSync(paths.pidPath)).toBe(false);
	});

	it.each([
		["another process or a reused pid", "foreign"],
		["a pid it cannot identify", "unknown"],
	] as const)(
		"refuses to kill a silent pid that is %s",
		async (_name, identity) => {
			const { paths } = seamHome();
			const table = fakeProcessTable([424242]);
			silentPidFile(paths, 424242);

			const failure = await cmdStop(
				{ force: true },
				{
					platform: "linux",
					kill: table.kill,
					exec: table.exec,
					waitMs: 100,
					identify: () => identity,
				},
			).catch((err: unknown) => err);

			expect(failure).toBeInstanceOf(DgCliError);
			expect((failure as DgCliError).exitCode).toBe(1);
			expect((failure as DgCliError).message).toContain(
				"cannot confirm it is dg-daemon",
			);
			expect(table.signals()).toEqual([]);
			expect(existsSync(paths.pidPath)).toBe(true);
		},
	);

	it("kills the daemon with a list failure when /services never answers", async () => {
		const { paths } = seamHome();
		const table = fakeProcessTable([424242]);
		const instanceId = crypto.randomUUID();
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(req) {
				if (new URL(req.url).pathname === "/healthz")
					return Response.json({ instanceId });
				return new Promise<Response>(() => {});
			},
		});
		cleanups.push(() => server.stop(true));
		ensureOwnerToken(paths);
		writePidFileAtomic(
			paths,
			handleFor({ pid: 424242, port: server.port as number, instanceId }),
		);

		const failure = await cmdStop(
			{ force: true },
			{
				platform: "linux",
				kill: table.kill,
				exec: table.exec,
				waitMs: 2000,
				listTimeoutMs: 200,
			},
		).catch((err: unknown) => err);

		expect(failure).toBeInstanceOf(DgCliError);
		expect((failure as DgCliError).message).toContain(
			"could not list the services (",
		);
		expect(table.signals()).toEqual([{ pid: 424242, signal: "SIGKILL" }]);
	});

	it("treats a /services answer from another instance as a list failure and uses none of its pids", async () => {
		const { paths } = seamHome();
		const table = fakeProcessTable([424242, 424243]);
		fakeDaemonWithServices(paths, 424242, [424243], "some-other-instance");

		const failure = await cmdStop(
			{ force: true },
			{ platform: "linux", kill: table.kill, exec: table.exec, waitMs: 2000 },
		).catch((err: unknown) => err);

		expect(failure).toBeInstanceOf(DgCliError);
		expect((failure as DgCliError).message).toContain(
			"could not list the services (",
		);
		expect(table.signals().map((call) => Math.abs(call.pid))).toEqual([424242]);
	});

	it("signals only integer service pids above 1", async () => {
		const { paths } = seamHome();
		const table = fakeProcessTable([424242, 424243]);
		fakeDaemonWithServices(paths, 424242, [0, 1, 1.5, 424243]);
		captureStdout();

		await cmdStop(
			{ force: true },
			{ platform: "linux", kill: table.kill, exec: table.exec, waitMs: 2000 },
		);

		expect(new Set(table.calls.map((call) => Math.abs(call.pid)))).toEqual(
			new Set([424242, 424243]),
		);
	});

	it("takes one taskkill per process and no kill call on win32, even for a regular stop", async () => {
		const { paths } = seamHome();
		const table = fakeProcessTable([424242, 424243, 424244]);
		fakeDaemonWithServices(paths, 424242, [424243, 424244]);
		const lines = captureStdout();

		await cmdStop(
			{},
			{ platform: "win32", kill: table.kill, exec: table.exec, waitMs: 2000 },
		);

		expect(table.execs).toEqual([
			{ command: "taskkill", args: ["/F", "/PID", "424242"] },
			...[424243, 424244].map((pid) => ({
				command: "taskkill",
				args: ["/T", "/F", "/PID", String(pid)],
			})),
		]);
		expect(table.signals()).toEqual([]);
		expect(lines()).toEqual(["dg-daemon stopped (pid 424242, forced)"]);
	});

	it("accepts a /services answer with no instanceId from a daemon before this change", async () => {
		const { paths } = seamHome();
		const table = fakeProcessTable([424242, 424243]);
		fakeDaemonWithServices(paths, 424242, [424243], null);
		const lines = captureStdout();

		await cmdStop(
			{ force: true },
			{ platform: "linux", kill: table.kill, exec: table.exec, waitMs: 2000 },
		);

		expect(new Set(table.calls.map((call) => Math.abs(call.pid)))).toEqual(
			new Set([424242, 424243]),
		);
		expect(lines()).toEqual(["dg-daemon stopped (pid 424242, forced)"]);
	});

	it("sends no signal when no daemon is live", async () => {
		seamHome();
		const table = fakeProcessTable([]);
		const lines = captureStdout();

		await cmdStop(
			{},
			{ platform: "linux", kill: table.kill, exec: table.exec, waitMs: 100 },
		);

		expect(table.calls).toEqual([]);
		expect(lines()).toEqual(["dg-daemon: no live daemon"]);
	});

	it("starts nothing and rejects with exit code 1 when the stop of a restart fails", async () => {
		const { dgHome, paths } = seamHome();
		const child = Bun.spawn(
			[
				process.execPath,
				"-e",
				"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",
			],
			{ stdout: "ignore", stderr: "ignore" },
		);
		cleanups.push(() => void child.kill("SIGKILL"));
		const instanceId = crypto.randomUUID();
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => Response.json({ instanceId }),
		});
		cleanups.push(() => server.stop(true));
		writePidFileAtomic(
			paths,
			handleFor({ pid: child.pid, port: server.port as number, instanceId }),
		);
		await Bun.sleep(300);
		const lines = captureStdout();

		const failure = await cmdRestart({}, { waitMs: 300 }).catch(
			(err: unknown) => err,
		);

		expect(failure).toBeInstanceOf(DgCliError);
		expect((failure as DgCliError).exitCode).toBe(1);
		expect(lines().some((line) => line.startsWith("dg-daemon started"))).toBe(
			false,
		);
		expect(readPidFile(dgHome).pid).toBe(child.pid);
	});
});

describe("dg-daemon restart", () => {
	it("replaces a live daemon: two lines, a new pid, one daemon process", async () => {
		const { dgHome, port } = homeWithPort();
		await dg(dgHome, port, ["start"]);
		const oldPid = readPidFile(dgHome).pid;

		const result = await dg(dgHome, port, ["restart"]);

		expect(result.code).toBe(0);
		const [stopLine, startLine, ...rest] = result.stdout.trimEnd().split("\n");
		expect(rest).toEqual([]);
		expect(`${stopLine}\n`).toMatch(STOPPED);
		expect(`${startLine}\n`).toMatch(STARTED);
		const newPid = readPidFile(dgHome).pid;
		expect(newPid).not.toBe(oldPid);
		expect(startLine).toContain(`(pid ${newPid},`);
		expect(pidAlive(oldPid)).toBe(false);
		expect(pidAlive(newPid)).toBe(true);
		await waitForHealth(port);
	});

	it("starts a daemon when none runs, after the no-live-daemon line", async () => {
		const { dgHome, port } = homeWithPort();

		const result = await dg(dgHome, port, ["restart"]);

		expect(result.code).toBe(0);
		const [first, second] = result.stdout.trimEnd().split("\n");
		expect(first).toBe("dg-daemon: no live daemon");
		expect(`${second}\n`).toMatch(STARTED);
		await waitForHealth(port);
	});

	it("runs only the autostart services afterwards", async () => {
		const { dgHome, port } = homeWithPort();
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		declareServices(paths, {
			auto: LONG_SERVICE(1000, true),
			manual: LONG_SERVICE(1000, false),
		});
		await dg(dgHome, port, ["start"]);
		await until(async () =>
			(await listServices(port, dgHome)).some(
				(s) => s.label === "auto" && s.state === "running",
			),
		);
		await startServiceViaHttp(port, "manual", dgHome);

		const result = await dg(dgHome, port, ["restart"]);

		expect(result.code).toBe(0);
		await until(async () =>
			(await listServices(port, dgHome)).some(
				(s) => s.label === "auto" && s.state === "running",
			),
		);
		const states = Object.fromEntries(
			(await listServices(port, dgHome)).map((s) => [s.label, s.state]),
		);
		expect(states.manual).toBe("stopped");
	}, 30_000);
	it.skipIf(process.platform !== "linux")(
		"gives the new daemon the environment of the caller",
		async () => {
			const { dgHome, port } = homeWithPort();
			await dg(dgHome, port, ["start"]);

			await dg(dgHome, port, ["restart"], {
				DG_RESTART_MARK: "from-the-caller",
			});

			const environ = readFileSync(
				`/proc/${readPidFile(dgHome).pid}/environ`,
				"utf8",
			);
			expect(environ.split("\0")).toContain("DG_RESTART_MARK=from-the-caller");
		},
	);
});
