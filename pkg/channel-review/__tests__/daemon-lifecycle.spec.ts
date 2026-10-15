import { afterEach, describe, expect, test } from "bun:test";
import {
	appendFileSync,
	existsSync,
	fstatSync,
	readFileSync,
	writeFileSync,
	mkdirSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isOurDaemon, start, stop } from "../src/daemon";
import type { ChildLike } from "../src/daemon";
import {
	DAEMON_ARGS,
	type DaemonHarness,
	type DaemonHarnessOptions,
	type FakeChild,
	createDaemonHarness,
	createFakeChild,
	termSignals,
} from "./daemon-harness";
import { waitUntil } from "./support/fakes";

const harnesses: DaemonHarness[] = [];

function setup(options: DaemonHarnessOptions = {}): DaemonHarness {
	const harness = createDaemonHarness(options);
	harnesses.push(harness);
	return harness;
}

afterEach(async () => {
	await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
});

describe("isOurDaemon", () => {
	test("accepts a live pid whose command line has channel-review and run", async () => {
		const h = setup();
		h.platform.alive.add(10);
		h.platform.argsByPid.set(10, DAEMON_ARGS);
		expect(await isOurDaemon(10, h.platform)).toBe(true);
	});

	test("rejects a live pid whose command line lacks channel-review", async () => {
		const h = setup();
		h.platform.alive.add(10);
		h.platform.argsByPid.set(10, "/usr/bin/bun run server.ts");
		expect(await isOurDaemon(10, h.platform)).toBe(false);
	});

	test("rejects a channel-review command line that is not the run subcommand", async () => {
		const h = setup();
		h.platform.alive.add(10);
		h.platform.argsByPid.set(10, "dg-skills channel-review status");
		expect(await isOurDaemon(10, h.platform)).toBe(false);
	});

	test("rejects a dead pid without reading its command line", async () => {
		const h = setup();
		h.platform.argsByPid.set(10, DAEMON_ARGS);
		expect(await isOurDaemon(10, h.platform)).toBe(false);
		expect(h.platform.listed).toHaveLength(0);
	});

	test("counts EPERM as alive", async () => {
		const h = setup();
		h.platform.epermPids.add(10);
		h.platform.argsByPid.set(10, DAEMON_ARGS);
		expect(await isOurDaemon(10, h.platform)).toBe(true);
	});

	test("reads the command line through the platform seam on win32", async () => {
		const h = setup({ platform: "win32" });
		h.platform.alive.add(10);
		h.platform.argsByPid.set(10, "C:\\dg-skills.exe channel-review run --env dev");
		expect(await isOurDaemon(10, h.platform)).toBe(true);
		expect(h.platform.listed).toEqual([10]);
	});
});

type Spawned = { command: string; args: string[]; options: Record<string, any>; child: FakeChild };

type FakeSpawnOptions = {
	pid?: number;
	pidfile?: number | "none";
	delayMs?: number;
	exitCode?: number;
	logLines?: number;
	beforeSpawn?: () => void;
};

function fakeSpawn(h: DaemonHarness, behavior: FakeSpawnOptions = {}) {
	const spawned: Spawned[] = [];
	const pid = behavior.pid ?? 5551;
	const spawn = (command: string, args: string[], options: Record<string, any>): ChildLike => {
		behavior.beforeSpawn?.();
		const child = createFakeChild(pid);
		spawned.push({ command, args, options, child });
		const envName = args[args.indexOf("--env") + 1] ?? "dev";
		const paths = h.pathsFor(envName as "dev" | "prod");
		setTimeout(() => {
			for (let i = 1; i <= (behavior.logLines ?? 0); i++) {
				appendFileSync(paths.logPath, `log-line-${i}\n`);
			}
			if (behavior.exitCode !== undefined) {
				child.exitCode = behavior.exitCode;
				child.emit("exit", behavior.exitCode);
				return;
			}
			if (behavior.pidfile === "none") return;
			mkdirSync(dirname(paths.pidPath), { recursive: true });
			writeFileSync(
				paths.pidPath,
				JSON.stringify({
					pid: behavior.pidfile ?? pid,
					env: envName,
					startedAt: "2026-10-14T12:00:00.000Z",
					chats: [{ id: "chat-1", topic: "Team Reviews" }],
				}),
			);
		}, behavior.delayMs ?? 5);
		return child as unknown as ChildLike;
	};
	return { spawn, spawned };
}

function startSeams(h: DaemonHarness, spawn: ReturnType<typeof fakeSpawn>["spawn"], extra: Record<string, unknown> = {}) {
	return {
		platform: h.platform,
		system: h.system,
		io: h.io,
		which: () => "/usr/bin/aws",
		spawn,
		execPath: "/usr/bin/bun",
		argv: ["/usr/bin/bun", import.meta.path],
		startTimeoutMs: 2000,
		killEscalationMs: 30,
		pollIntervalMs: 5,
		...extra,
	};
}

function flag(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
}

describe("start", () => {
	test("spawns a detached run with the env passed explicitly and exits 0 once the child's pidfile appears", async () => {
		const h = setup();
		const { spawn, spawned } = fakeSpawn(h);
		expect(await start({}, startSeams(h, spawn))).toBe(0);
		expect(spawned).toHaveLength(1);
		const [{ command, args, options, child }] = spawned as [Spawned];
		expect([command, ...args.slice(0, 3)]).toEqual(["/usr/bin/bun", import.meta.path, "channel-review", "run"]);
		expect(flag(args, "--env")).toBe("dev");
		expect(options.detached).toBe(true);
		expect(options.cwd).toBe(dirname(h.paths.configPath));
		expect(options.stdio[0]).toBe("ignore");
		expect(typeof options.stdio[1]).toBe("number");
		expect(options.stdio[2]).toBe(options.stdio[1]);
		expect(child.unrefCalls).toBe(1);
		expect(child.killCalls).toHaveLength(0);
	});

	test("closes the log fd in the parent", async () => {
		const h = setup();
		const { spawn, spawned } = fakeSpawn(h);
		await start({}, startSeams(h, spawn));
		const fd = spawned[0]!.options.stdio[1] as number;
		expect(() => fstatSync(fd)).toThrow();
	});

	test("passes --runner and --chat-id through to run", async () => {
		const h = setup();
		const { spawn, spawned } = fakeSpawn(h);
		await start({ runner: "codex", chatId: "19:x@thread.v2" }, startSeams(h, spawn));
		const args = spawned[0]!.args;
		expect(flag(args, "--runner")).toBe("codex");
		expect(flag(args, "--chat-id")).toBe("19:x@thread.v2");
	});

	test("start --env prod spawns run with --env prod, writes only the prod pidfile, and leaves the dev pidfile alone", async () => {
		const h = setup({ envName: "prod" });
		h.writePidfile(7777, "dev");
		const devBefore = readFileSync(h.pathsFor("dev").pidPath, "utf8");
		const { spawn, spawned } = fakeSpawn(h);
		expect(await start({ env: "prod" }, startSeams(h, spawn))).toBe(0);
		expect(flag(spawned[0]!.args, "--env")).toBe("prod");
		expect(existsSync(h.pathsFor("prod").pidPath)).toBe(true);
		expect(readFileSync(h.pathsFor("dev").pidPath, "utf8")).toBe(devBefore);
	});

	test("uses env.default from config when no env option is given", async () => {
		const h = setup({ envName: "prod", configExtra: { env: { default: "prod" } } });
		const { spawn, spawned } = fakeSpawn(h);
		await start({}, startSeams(h, spawn));
		expect(flag(spawned[0]!.args, "--env")).toBe("prod");
	});

	test("refuses with exit 1 when a live daemon owns the pidfile", async () => {
		const h = setup();
		h.writePidfile(4242);
		h.platform.alive.add(4242);
		h.platform.argsByPid.set(4242, DAEMON_ARGS);
		const { spawn, spawned } = fakeSpawn(h);
		expect(await start({}, startSeams(h, spawn))).toBe(1);
		expect(spawned).toHaveLength(0);
		expect(existsSync(h.paths.pidPath)).toBe(true);
	});

	test("removes a stale pidfile before the spawn and then starts", async () => {
		const h = setup();
		h.writePidfile(4242);
		h.platform.alive.add(4242);
		h.platform.argsByPid.set(4242, "/usr/bin/vim");
		let pidfileAtSpawn: boolean | undefined;
		const { spawn } = fakeSpawn(h, {
			beforeSpawn: () => {
				pidfileAtSpawn = existsSync(h.paths.pidPath);
			},
		});
		expect(await start({}, startSeams(h, spawn))).toBe(0);
		expect(pidfileAtSpawn).toBe(false);
	});

	test("rotates the previous log to daemon.<env>.log.1", async () => {
		const h = setup();
		writeFileSync(h.paths.logPath, "OLD LOG\n");
		const { spawn } = fakeSpawn(h);
		await start({}, startSeams(h, spawn));
		expect(readFileSync(`${h.paths.logPath}.1`, "utf8")).toBe("OLD LOG\n");
	});

	test("without config.json it exits 1 naming the config path and does not spawn", async () => {
		const h = setup({ writeConfig: false });
		const { spawn, spawned } = fakeSpawn(h);
		expect(await start({}, startSeams(h, spawn))).toBe(1);
		expect(h.io.all()).toContain(h.paths.configPath);
		expect(spawned).toHaveLength(0);
	});

	test("without the aws CLI it exits 1 naming aws and does not spawn", async () => {
		const h = setup();
		const { spawn, spawned } = fakeSpawn(h);
		expect(await start({}, startSeams(h, spawn, { which: () => null }))).toBe(1);
		expect(h.io.all()).toContain("aws");
		expect(spawned).toHaveLength(0);
	});

	test("kills the child, prints the last 20 log lines, and exits 1 when no pidfile appears in time", async () => {
		const h = setup();
		const { spawn, spawned } = fakeSpawn(h, { pidfile: "none", logLines: 30 });
		const code = await start({}, startSeams(h, spawn, { startTimeoutMs: 80 }));
		expect(code).toBe(1);
		expect(spawned[0]!.child.killCalls).toEqual(["SIGTERM", "SIGKILL"]);
		const output = h.io.all();
		expect(output).toContain("log-line-30");
		expect(output).toContain("log-line-11");
		expect(output).not.toMatch(/^log-line-10$/m);
	});

	test("does not send SIGKILL when the child exits after SIGTERM", async () => {
		const h = setup();
		const { spawn, spawned } = fakeSpawn(h, { pidfile: "none" });
		const code = await start(
			{},
			startSeams(h, (command, args, options) => {
				const child = spawn(command, args, options) as unknown as FakeChild;
				child.kill = (signal) => {
					child.killCalls.push(signal);
					child.exitCode = 0;
					child.emit("exit", 0);
					return true;
				};
				return child;
			}, { startTimeoutMs: 80 }),
		);
		expect(code).toBe(1);
		expect(spawned[0]!.child.killCalls).toEqual(["SIGTERM"]);
	});

	test("accepts only a pidfile whose pid equals the child's pid", async () => {
		const h = setup();
		const { spawn, spawned } = fakeSpawn(h, { pid: 5551, pidfile: 9999 });
		expect(await start({}, startSeams(h, spawn, { startTimeoutMs: 80 }))).toBe(1);
		expect(spawned[0]!.child.killCalls[0]).toBe("SIGTERM");
	});

	test("prints the last 20 log lines and exits 1 when the child exits first, without killing it", async () => {
		const h = setup();
		const { spawn, spawned } = fakeSpawn(h, { exitCode: 1, logLines: 25 });
		expect(await start({}, startSeams(h, spawn))).toBe(1);
		expect(h.io.all()).toContain("log-line-25");
		expect(h.io.all()).toContain("log-line-6");
		expect(spawned[0]!.child.killCalls).toHaveLength(0);
	});

	test("uses the compiled argv shape when argv[1] is under /$bunfs/", async () => {
		const h = setup();
		const { spawn, spawned } = fakeSpawn(h);
		await start({}, startSeams(h, spawn, { argv: ["/usr/bin/bun", "/$bunfs/root/dg-skills"] }));
		expect([spawned[0]!.command, ...spawned[0]!.args.slice(0, 2)]).toEqual([
			"/usr/bin/bun",
			"channel-review",
			"run",
		]);
	});

	test("uses the compiled argv shape when argv[1] does not exist on disk", async () => {
		const h = setup();
		const { spawn, spawned } = fakeSpawn(h);
		const missing = join(h.home.dir, "no-such-entry.js");
		await start({}, startSeams(h, spawn, { argv: ["/usr/bin/bun", missing] }));
		expect(spawned[0]!.args.slice(0, 2)).toEqual(["channel-review", "run"]);
	});

	test("replaces the leading argv with runArgv when given", async () => {
		const h = setup();
		const { spawn, spawned } = fakeSpawn(h);
		await start({}, startSeams(h, spawn, { runArgv: ["/usr/bin/fake", "runner.ts"] }));
		expect([spawned[0]!.command, ...spawned[0]!.args.slice(0, 1)]).toEqual(["/usr/bin/fake", "runner.ts"]);
		expect(flag(spawned[0]!.args, "--env")).toBe("dev");
	});
});

describe("start on win32", () => {
	function win32Seams(h: DaemonHarness, spawn: ReturnType<typeof fakeSpawn>["spawn"], extra: Record<string, unknown> = {}) {
		return startSeams(h, spawn, {
			argv: ["C:\\dg-skills.exe", "B:\\~BUN\\root\\dg-skills.exe"],
			execPath: "C:\\dg-skills.exe",
			...extra,
		});
	}

	test("spawns detached with windowsHide and accepts the B:\\~BUN\\ compiled prefix", async () => {
		const h = setup({ platform: "win32" });
		const { spawn, spawned } = fakeSpawn(h);
		expect(await start({}, win32Seams(h, spawn))).toBe(0);
		const [{ command, args, options }] = spawned as [Spawned];
		expect(options.detached).toBe(true);
		expect(options.windowsHide).toBe(true);
		expect(command).toBe("C:\\dg-skills.exe");
		expect(args.slice(0, 2)).toEqual(["channel-review", "run"]);
	});

	test("kills the process tree through the platform seam on a startup timeout", async () => {
		const h = setup({ platform: "win32" });
		const { spawn, spawned } = fakeSpawn(h, { pidfile: "none", pid: 5551 });
		expect(await start({}, win32Seams(h, spawn, { startTimeoutMs: 80 }))).toBe(1);
		expect(h.platform.killed).toEqual([5551]);
		expect(spawned[0]!.child.killCalls).toHaveLength(0);
	});

	test("reads the existing daemon's command line through the seam before refusing", async () => {
		const h = setup({ platform: "win32" });
		h.writePidfile(4242);
		h.platform.alive.add(4242);
		h.platform.argsByPid.set(4242, "C:\\dg-skills.exe channel-review run --env dev");
		const { spawn } = fakeSpawn(h);
		expect(await start({}, win32Seams(h, spawn))).toBe(1);
		expect(h.platform.listed).toContain(4242);
	});
});

describe("start with a real detached child", () => {
	test("a spawned fixture that writes the pidfile satisfies start and survives it", async () => {
		const h = setup();
		const script = join(h.home.dir, "fake-run.ts");
		writeFileSync(
			script,
			[
				'import { mkdirSync, writeFileSync } from "node:fs";',
				'import { dirname, join } from "node:path";',
				'const args = process.argv.slice(2);',
				'const env = args[args.indexOf("--env") + 1] ?? "dev";',
				'const path = join(process.env.DG_HOME ?? "", "channel-review", `daemon.${env}.pid`);',
				"mkdirSync(dirname(path), { recursive: true });",
				"writeFileSync(path, JSON.stringify({ pid: process.pid, env }));",
				"setTimeout(() => process.exit(0), 20000);",
				"process.on('SIGTERM', () => process.exit(0));",
			].join("\n"),
		);
		let childPid: number | undefined;
		try {
			const code = await start(
				{ env: "prod" },
				{
					platform: {
						...h.platform,
						signal: (pid, sig) => process.kill(pid, sig),
						killTree: (pid) => {
							process.kill(pid, "SIGKILL");
						},
					},
					system: h.system,
					io: h.io,
					which: () => "/usr/bin/aws",
					runArgv: [process.execPath, script],
					startTimeoutMs: 10_000,
				},
			);
			expect(code).toBe(0);
			childPid = (h.readJson(h.pathsFor("prod").pidPath) as { pid: number }).pid;
			expect(() => process.kill(childPid as number, 0)).not.toThrow();
		} finally {
			if (childPid !== undefined) {
				try {
					process.kill(childPid, "SIGKILL");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
				}
			}
		}
	});
});

describe("stop", () => {
	test("prints not running and exits 0 when there is no pidfile", async () => {
		const h = setup();
		const code = await stop({}, { platform: h.platform, system: h.system, io: h.io, ...h.seams });
		expect(code).toBe(0);
		expect(h.io.all()).toContain("not running");
		expect(termSignals(h.platform)).toHaveLength(0);
	});

	test("prints not running and sends no signal when the pid belongs to an unrelated process", async () => {
		const h = setup();
		h.writePidfile(4242);
		h.platform.alive.add(4242);
		h.platform.argsByPid.set(4242, "/usr/bin/vim notes.md");
		const code = await stop({}, { platform: h.platform, system: h.system, io: h.io, ...h.seams });
		expect(code).toBe(0);
		expect(h.io.all()).toContain("not running");
		expect(termSignals(h.platform)).toHaveLength(0);
		expect(h.platform.killed).toHaveLength(0);
	});

	test("sends SIGTERM, waits for exit, removes the pidfile, and exits 0", async () => {
		const h = setup();
		h.writePidfile(4242);
		h.platform.alive.add(4242);
		h.platform.argsByPid.set(4242, DAEMON_ARGS);
		h.platform.onSignal = (pid, signal) => {
			if (signal === "SIGTERM") h.platform.alive.delete(pid);
		};
		const code = await stop(
			{},
			{ platform: h.platform, system: h.system, io: h.io, ...h.seams, termTimeoutMs: 2000, pollIntervalMs: 5 },
		);
		expect(code).toBe(0);
		expect(termSignals(h.platform)).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
		expect(existsSync(h.paths.pidPath)).toBe(false);
	});

	test("sends SIGKILL when the daemon outlives the SIGTERM wait", async () => {
		const h = setup();
		h.writePidfile(4242);
		h.platform.alive.add(4242);
		h.platform.argsByPid.set(4242, DAEMON_ARGS);
		h.platform.onSignal = (pid, signal) => {
			if (signal === "SIGKILL") h.platform.alive.delete(pid);
		};
		const code = await stop(
			{},
			{ platform: h.platform, system: h.system, io: h.io, ...h.seams, termTimeoutMs: 40, pollIntervalMs: 5 },
		);
		expect(code).toBe(0);
		expect(termSignals(h.platform).map((entry) => entry.signal)).toEqual(["SIGTERM", "SIGKILL"]);
		expect(existsSync(h.paths.pidPath)).toBe(false);
	});

	test("stop --env prod leaves the dev daemon alone", async () => {
		const h = setup({ envName: "prod" });
		h.writePidfile(4242, "dev");
		h.platform.alive.add(4242);
		h.platform.argsByPid.set(4242, DAEMON_ARGS);
		const code = await stop({ env: "prod" }, { platform: h.platform, system: h.system, io: h.io, ...h.seams });
		expect(code).toBe(0);
		expect(termSignals(h.platform)).toHaveLength(0);
		expect(existsSync(h.pathsFor("dev").pidPath)).toBe(true);
	});
});

describe("stop on win32", () => {
	test("kills the daemon tree once, then recovers the running job with the failure reaction and a CR-205 reply", async () => {
		const h = setup({ platform: "win32" });
		h.writePidfile(4242);
		h.platform.alive.add(4242);
		h.platform.argsByPid.set(4242, "C:\\dg-skills.exe channel-review run --env dev");
		h.seedState((store) => store.markHandled("m1", "running"));
		const code = await stop({}, { platform: h.platform, system: h.system, io: h.io, ...h.seams });
		expect(code).toBe(0);
		expect(h.platform.killed).toEqual([4242]);
		expect(termSignals(h.platform)).toHaveLength(0);
		await waitUntil(() => h.providers.length === 1);
		const provider = h.provider();
		expect(provider.calls.some((c) => c.op === "react" && c.messageId === "m1" && c.reactionId === h.config.reactions.failure)).toBe(true);
		expect(provider.replies().some((r) => r.text.startsWith("CR-205"))).toBe(true);
		expect(existsSync(h.paths.pidPath)).toBe(false);
		expect(h.readState().handled).toMatchObject({ m1: { status: "failed" } });
	});

	test("a win32 stop with no live daemon prints not running and never kills", async () => {
		const h = setup({ platform: "win32" });
		const code = await stop({}, { platform: h.platform, system: h.system, io: h.io, ...h.seams });
		expect(code).toBe(0);
		expect(h.io.all()).toContain("not running");
		expect(h.platform.killed).toHaveLength(0);
		expect(h.providers).toHaveLength(0);
	});
});
