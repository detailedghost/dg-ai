import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonLayoutHooks } from "../src/layout-hooks";
import { hooksFor } from "../src/main";

const SRC = join(import.meta.dir, "..", "src");
const KILL_DELAY_MS = 300;
const STOP_CAP_MS = 5000;
const POLL_MS = 100;

type Stop = (legacyDir: string) => Promise<string>;

let dir: string;
let sleepers: ReturnType<typeof Bun.spawn>[];
let written: string[];
let stderr: ReturnType<typeof spyOn>;

function sleeper(): ReturnType<typeof Bun.spawn> {
	const child = Bun.spawn(["sleep", "300"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
	sleepers.push(child);
	return child;
}

function writeHandle(pid: number, instanceId = "instance-1"): void {
	writeFileSync(
		join(dir, "daemon.pid"),
		JSON.stringify({ pid, port: 1, instanceId, versions: { package: "test", protocol: 1 } }),
	);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dg-daemon-layout-hooks-"));
	sleepers = [];
	written = [];
	stderr = spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
		written.push(String(chunk));
		return true;
	}) as typeof process.stderr.write);
});

afterEach(() => {
	stderr.mockRestore();
	for (const child of sleepers) child.kill("SIGKILL");
	rmSync(dir, { recursive: true, force: true });
});

function stopOf(deps: Record<string, unknown>): Stop {
	return daemonLayoutHooks(deps as Parameters<typeof daemonLayoutHooks>[0])["daemon.stop"] as Stop;
}

describe("daemonLayoutHooks daemon.stop", () => {
	test("returns stopped within 1 s when the process dies 300 ms after SIGTERM", async () => {
		const child = sleeper();
		writeHandle(child.pid);
		const signals: [number, string][] = [];
		let elapsed = 0;
		const stop = stopOf({
			platform: "linux",
			isLive: async () => true,
			kill: (pid: number, signal: string) => {
				signals.push([pid, signal]);
			},
			sleep: async (ms: number) => {
				elapsed += ms;
				if (elapsed >= KILL_DELAY_MS && child.exitCode === null) {
					child.kill("SIGKILL");
					await child.exited;
				}
			},
		});
		const started = Date.now();

		const result = await stop(dir);

		expect(result).toBe("stopped");
		expect(Date.now() - started).toBeLessThan(1000);
		expect(signals).toEqual([[child.pid, "SIGTERM"]]);
	});

	test("returns still-running after 5000 ms of fake time when the process never dies", async () => {
		const child = sleeper();
		writeHandle(child.pid);
		const sleeps: number[] = [];
		const stop = stopOf({
			platform: "linux",
			isLive: async () => true,
			kill: () => {},
			sleep: async (ms: number) => {
				sleeps.push(ms);
			},
		});

		const result = await stop(dir);

		const total = sleeps.reduce((sum, ms) => sum + ms, 0);
		expect(result).toBe("still-running");
		expect(new Set(sleeps)).toEqual(new Set([POLL_MS]));
		expect(total).toBeGreaterThanOrEqual(STOP_CAP_MS);
		expect(total).toBeLessThanOrEqual(STOP_CAP_MS + POLL_MS);
	});

	test("returns refused on win32 without a kill and logs the service line", async () => {
		const child = sleeper();
		writeHandle(child.pid);
		const signals: unknown[] = [];
		const stop = stopOf({
			platform: "win32",
			isLive: async () => true,
			kill: (...args: unknown[]) => {
				signals.push(args);
			},
			sleep: async () => {},
		});

		const result = await stop(dir);

		expect(result).toBe("refused");
		expect(signals).toEqual([]);
		expect(written.join("")).toContain(`dg: kept ${dir}; stop the dg-daemon service, then run dg-skills install again`);
	});

	test("returns stopped without a signal when the pid file instanceId is not live", async () => {
		const child = sleeper();
		writeHandle(child.pid, "someone-else");
		const signals: unknown[] = [];
		const stop = stopOf({
			platform: "linux",
			isLive: async () => false,
			kill: (...args: unknown[]) => {
				signals.push(args);
			},
			sleep: async () => {},
		});

		const result = await stop(dir);

		expect(result).toBe("stopped");
		expect(signals).toEqual([]);
	});

	test("returns stopped without a signal when the folder holds no readable pid file", async () => {
		writeFileSync(join(dir, "daemon.pid"), "not json");
		const signals: unknown[] = [];
		const stop = stopOf({
			platform: "linux",
			isLive: async () => true,
			kill: (...args: unknown[]) => {
				signals.push(args);
			},
			sleep: async () => {},
		});

		expect(await stop(dir)).toBe("stopped");
		expect(await stop(join(dir, "missing"))).toBe("stopped");
		expect(signals).toEqual([]);
	});

	test("deletes the stale pid file when the instance is not live and the pid is dead", async () => {
		const child = sleeper();
		child.kill("SIGKILL");
		await child.exited;
		writeHandle(child.pid, "someone-else");
		const stop = stopOf({ platform: "linux", isLive: async () => false, kill: () => {}, sleep: async () => {} });

		expect(await stop(dir)).toBe("stopped");

		expect(existsSync(join(dir, "daemon.pid"))).toBe(false);
	});

	test("keeps the pid file when the instance is not live but the pid is alive", async () => {
		const child = sleeper();
		writeHandle(child.pid, "someone-else");
		const stop = stopOf({ platform: "linux", isLive: async () => false, kill: () => {}, sleep: async () => {} });

		expect(await stop(dir)).toBe("stopped");

		expect(existsSync(join(dir, "daemon.pid"))).toBe(true);
	});

	test("returns stopped when kill reports ESRCH", async () => {
		const child = sleeper();
		writeHandle(child.pid);
		const stop = stopOf({
			platform: "linux",
			isLive: async () => true,
			kill: () => {
				throw Object.assign(new Error("no such process"), { code: "ESRCH" });
			},
			sleep: async () => {},
		});

		expect(await stop(dir)).toBe("stopped");
	});

	test("keeps the pid file and sends exactly one SIGTERM when the process never dies", async () => {
		const child = sleeper();
		writeHandle(child.pid);
		const signals: unknown[] = [];
		const stop = stopOf({
			platform: "linux",
			isLive: async () => true,
			kill: (...args: unknown[]) => {
				signals.push(args);
			},
			sleep: async () => {},
		});

		expect(await stop(dir)).toBe("still-running");

		expect(signals).toEqual([[child.pid, "SIGTERM"]]);
		expect(existsSync(join(dir, "daemon.pid"))).toBe(true);
	});

	test("returns stopped after the first poll when the signal kills the process at once", async () => {
		const child = sleeper();
		writeHandle(child.pid);
		const sleeps: number[] = [];
		const stop = stopOf({
			platform: "linux",
			isLive: async () => true,
			kill: () => {
				child.kill("SIGKILL");
			},
			sleep: async (ms: number) => {
				sleeps.push(ms);
				await child.exited;
			},
		});

		expect(await stop(dir)).toBe("stopped");

		expect(sleeps).toEqual([POLL_MS]);
	});

	test("leaves the pid file alone when it refuses on win32", async () => {
		writeHandle(process.pid);
		const stop = stopOf({ platform: "win32", isLive: async () => true, kill: () => {}, sleep: async () => {} });

		expect(await stop(dir)).toBe("refused");

		expect(existsSync(join(dir, "daemon.pid"))).toBe(true);
	});

	test("supplies only the daemon.stop key", () => {
		const hooks = daemonLayoutHooks({ platform: "linux" } as Parameters<typeof daemonLayoutHooks>[0]);

		expect(Object.keys(hooks)).toEqual(["daemon.stop"]);
	});
});

describe("daemonLayoutHooks module", () => {
	test("imports only the pidfile and plugin-cache subpaths and node builtins", () => {
		const text = readFileSync(join(SRC, "layout-hooks.ts"), "utf8");
		const specifiers = [...text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\sfrom\s+["']([^"']+)["']|(?:^|\n)\s*import\s+["']([^"']+)["']/g)].map(
			(match) => (match[1] ?? match[2]) as string,
		);

		expect(specifiers.length).toBeGreaterThan(0);
		for (const specifier of specifiers)
			expect(
				specifier.startsWith("node:") ||
					specifier === "@dg/common/node/pidfile" ||
					specifier === "@dg/common/node/plugin-cache",
			).toBe(true);
	});

	test("the package exports ./layout-hooks", () => {
		const manifest = JSON.parse(readFileSync(join(SRC, "..", "package.json"), "utf8")) as { exports: Record<string, string> };

		expect(manifest.exports["./layout-hooks"]).toBe("./src/layout-hooks.ts");
	});
});

describe("dg-daemon hooksFor", () => {
	test("__serve supplies daemon.stop and passes the injected platform through", async () => {
		const hooks = hooksFor("__serve", { platform: "win32" });
		await hooks.load?.();

		expect(typeof hooks["daemon.stop"]).toBe("function");
		expect(await hooks["daemon.stop"]?.(dir)).toBe("refused");
		expect(written.join("")).toContain("stop the dg-daemon service");
	});

	test("__serve on linux does not refuse", async () => {
		const hooks = hooksFor("__serve", { platform: "linux" });
		await hooks.load?.();

		expect(await hooks["daemon.stop"]?.(join(dir, "missing"))).toBe("stopped");
	});

	test.each(["status", "job", "list"])("%s supplies no daemon.stop", async (name) => {
		const hooks = hooksFor(name);
		await hooks.load?.();

		expect(hooks["daemon.stop"]).toBeUndefined();
	});
});

