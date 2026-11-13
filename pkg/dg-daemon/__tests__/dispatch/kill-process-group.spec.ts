import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { wait } from "@dg/common";
import { isAlive } from "@dg/common/node";
import { killProcessGroup } from "../../src/dispatch/exec";

type Call = { pid: number; signal: NodeJS.Signals | 0 };

const PID = 424242;
const GRACE_MS = 400;

type World = {
	calls: Call[];
	kill: (pid: number, signal: NodeJS.Signals | 0) => void;
	execs: Array<[string, string[]]>;
	exec: (command: string, args: string[]) => void;
	signals: () => Call[];
};

function world(groupAlive: () => boolean): World {
	const calls: Call[] = [];
	const execs: Array<[string, string[]]> = [];
	return {
		calls,
		execs,
		kill: (pid, signal) => {
			calls.push({ pid, signal });
			if (!groupAlive()) {
				throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
			}
		},
		exec: (command, args) => {
			execs.push([command, args]);
		},
		signals: () => calls.filter((c) => c.signal !== 0),
	};
}

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => {
	for (const spy of spies.splice(0)) spy.mockRestore();
});

describe("killProcessGroup", () => {
	it("resolves at the first empty probe with one SIGTERM and no SIGKILL, even if the number is reused later", async () => {
		const termAt: { at?: number } = {};
		let reused = false;
		const w = world(() => {
			if (reused) return true;
			return termAt.at === undefined || Date.now() < termAt.at + 50;
		});
		const kill = (pid: number, signal: NodeJS.Signals | 0) => {
			if (signal === "SIGTERM") termAt.at = Date.now();
			w.kill(pid, signal);
		};

		const startedAt = Date.now();
		await killProcessGroup(PID, GRACE_MS, {
			platform: "linux",
			kill,
			exec: w.exec,
		});
		expect(Date.now() - startedAt).toBeLessThan(GRACE_MS);

		reused = true;
		await wait(GRACE_MS + 200);
		expect(w.signals()).toEqual([{ pid: -PID, signal: "SIGTERM" }]);
		expect(w.execs).toEqual([]);
	});

	it("sends SIGKILL once at graceMs when the group stays alive, then resolves", async () => {
		let killed = false;
		const w = world(() => !killed);
		const kill = (pid: number, signal: NodeJS.Signals | 0) => {
			w.kill(pid, signal);
			if (signal === "SIGKILL") killed = true;
		};

		const startedAt = Date.now();
		await killProcessGroup(PID, GRACE_MS, {
			platform: "linux",
			kill,
			exec: w.exec,
		});
		const elapsed = Date.now() - startedAt;

		expect(elapsed).toBeGreaterThanOrEqual(GRACE_MS);
		expect(w.signals()).toEqual([
			{ pid: -PID, signal: "SIGTERM" },
			{ pid: -PID, signal: "SIGKILL" },
		]);
		expect(w.execs).toEqual([]);
	});

	it("resolves with no further signal when the group is already gone at SIGTERM", async () => {
		const w = world(() => false);
		await killProcessGroup(PID, GRACE_MS, {
			platform: "linux",
			kill: w.kill,
			exec: w.exec,
		});
		await wait(GRACE_MS + 100);
		expect(w.signals().every((c) => c.signal === "SIGTERM")).toBe(true);
		expect(w.signals().length).toBeLessThanOrEqual(1);
	});

	it("probes with signal 0 on timers that do not keep the process alive and stops probing once resolved", async () => {
		const timers: Array<{ hasRef: () => boolean }> = [];
		const realInterval = globalThis.setInterval;
		const realTimeout = globalThis.setTimeout;
		spies.push(
			spyOn(globalThis, "setInterval").mockImplementation(((
				...args: Parameters<typeof setInterval>
			) => {
				const t = realInterval(...args);
				timers.push(t as unknown as { hasRef: () => boolean });
				return t;
			}) as typeof setInterval),
			spyOn(globalThis, "setTimeout").mockImplementation(((
				...args: Parameters<typeof setTimeout>
			) => {
				const t = realTimeout(...args);
				timers.push(t as unknown as { hasRef: () => boolean });
				return t;
			}) as typeof setTimeout),
		);
		const start = Date.now();
		const w = world(() => Date.now() < start + 120);

		await killProcessGroup(PID, GRACE_MS, {
			platform: "linux",
			kill: w.kill,
			exec: w.exec,
		});
		for (const spy of spies.splice(0)) spy.mockRestore();

		expect(timers.length).toBeGreaterThan(0);
		expect(timers.every((t) => t.hasRef() === false)).toBe(true);
		expect(w.calls.filter((c) => c.signal === 0).length).toBeGreaterThan(0);

		const settled = w.calls.length;
		await wait(250);
		expect(w.calls.length).toBe(settled);
	});

	it("on win32 makes one taskkill call through killProcessTree, no kill call and no timer", async () => {
		const w = world(() => true);
		const intervalSpy = spyOn(globalThis, "setInterval");
		const timeoutSpy = spyOn(globalThis, "setTimeout");
		spies.push(intervalSpy, timeoutSpy);

		await killProcessGroup(PID, GRACE_MS, {
			platform: "win32",
			kill: w.kill,
			exec: w.exec,
		});

		expect(w.execs).toEqual([["taskkill", ["/T", "/F", "/PID", String(PID)]]]);
		expect(w.calls).toEqual([]);
		expect(intervalSpy).not.toHaveBeenCalled();
		expect(timeoutSpy).not.toHaveBeenCalled();
	});

	it("on POSIX never calls taskkill and has no immediate SIGKILL", async () => {
		const w = world(() => false);
		await killProcessGroup(PID, GRACE_MS, {
			platform: "linux",
			kill: w.kill,
			exec: w.exec,
		});
		expect(w.execs).toEqual([]);
		expect(w.signals().some((c) => c.signal === "SIGKILL")).toBe(false);
	});

	it("kills a real group that ignores SIGTERM only after graceMs", async () => {
		const proc = Bun.spawn(
			[
				process.execPath,
				"-e",
				'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);',
			],
			{ detached: true, stdout: "ignore", stderr: "ignore" },
		);
		await wait(300);
		const startedAt = Date.now();
		await killProcessGroup(proc.pid, 300);
		const elapsed = Date.now() - startedAt;
		await proc.exited;

		expect(elapsed).toBeGreaterThanOrEqual(300);
		expect(isAlive(proc.pid)).toBe(false);
		expect(proc.signalCode).toBe("SIGKILL");
	});
});
