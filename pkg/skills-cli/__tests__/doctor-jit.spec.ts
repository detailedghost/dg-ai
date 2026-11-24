import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jitState, longRunningJitCheck } from "../src/doctor/jit";
import type { DoctorContext } from "../src/doctor/types";

const root = mkdtempSync(join(tmpdir(), "dg-doctor-jit-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function fakeProcess(proc: string, pid: number, threads: string[], rssKb: number, argv = ["dg", "daemon", "serve"]): void {
	for (const [index, name] of threads.entries()) {
		mkdirSync(join(proc, String(pid), "task", String(pid + index)), { recursive: true });
		writeFileSync(join(proc, String(pid), "task", String(pid + index), "comm"), `${name}\n`);
	}
	writeFileSync(join(proc, String(pid), "status"), `Name:\tdg\nVmRSS:\t${rssKb} kB\n`);
	writeFileSync(join(proc, String(pid), "cmdline"), `${argv.join("\0")}\0`);
}

function context(dir: string): DoctorContext {
	const paths = { pidPath: join(dir, "daemon.pid"), phoneRoot: join(dir, "phone") } as DoctorContext["paths"];
	return { home: dir, env: {}, paths, installedVersion: "0.0.0", memo: (_key, make) => make() };
}

describe("jitState", () => {
	const proc = join(root, "proc-state");

	test("a process with JIT worker threads has the JIT on", () => {
		fakeProcess(proc, 100, ["dg", "HeapHelper", "JITWorker", "JSCWarmUp"], 50_000);
		expect(jitState(100, proc)).toBe("on");
	});

	test("a process with no JIT threads has the JIT off", () => {
		fakeProcess(proc, 200, ["dg", "HeapHelper", "Bun Pool 0"], 30_000);
		expect(jitState(200, proc)).toBe("off");
	});

	test("a missing process is unknown", () => {
		expect(jitState(999, proc)).toBe("unknown");
	});
});

describe("long-running JIT check", () => {
	test("reports the JIT state and RSS of the daemon and the listener", async () => {
		const dir = join(root, "ok");
		const proc = join(dir, "proc");
		mkdirSync(join(dir, "phone"), { recursive: true });
		writeFileSync(join(dir, "daemon.pid"), JSON.stringify({ pid: 300, port: 1, instanceId: "x", versions: { package: "1", protocol: 1 } }));
		writeFileSync(join(dir, "phone", "listener.pid"), JSON.stringify({ pid: 400, since: 0, hook: null }));
		fakeProcess(proc, 300, ["dg", "HeapHelper"], 38_000);
		fakeProcess(proc, 400, ["dg", "HeapHelper"], 46_000, ["dg", "agent", "phone", "listen"]);
		const result = await longRunningJitCheck(proc, "linux").run(context(dir));
		expect(result.status).toBe("ok");
		expect(result.detail).toBe("daemon pid 300: JIT off, 37.1 MB; phone listener pid 400: JIT off, 44.9 MB");
	});

	test("warns when a long-running process still has the JIT on", async () => {
		const dir = join(root, "warn");
		const proc = join(dir, "proc");
		mkdirSync(join(dir, "phone"), { recursive: true });
		writeFileSync(join(dir, "daemon.pid"), JSON.stringify({ pid: 500, port: 1, instanceId: "x", versions: { package: "1", protocol: 1 } }));
		fakeProcess(proc, 500, ["dg", "JITWorker"], 55_000);
		const result = await longRunningJitCheck(proc, "linux").run(context(dir));
		expect(result.status).toBe("warn");
		expect(result.detail).toContain("daemon pid 500: JIT on");
		expect(result.fix).toBe("dg daemon restart");
	});

	test("lists both restart commands when both processes have the JIT on", async () => {
		const dir = join(root, "both");
		const proc = join(dir, "proc");
		mkdirSync(join(dir, "phone"), { recursive: true });
		writeFileSync(join(dir, "daemon.pid"), JSON.stringify({ pid: 800, port: 1, instanceId: "x", versions: { package: "1", protocol: 1 } }));
		writeFileSync(join(dir, "phone", "listener.pid"), JSON.stringify({ pid: 900, since: 0, hook: null }));
		fakeProcess(proc, 800, ["dg", "JITWorker"], 55_000);
		fakeProcess(proc, 900, ["dg", "JITWorker"], 70_000, ["/home/u/.local/share/dg/bin/current/dg", "agent", "phone", "listen"]);
		const result = await longRunningJitCheck(proc, "linux").run(context(dir));
		expect(result.fix).toBe("dg daemon restart; dg phone close && dg phone open");
	});

	test("DG_JIT=1 turns the warning into ok", async () => {
		const dir = join(root, "kept");
		const proc = join(dir, "proc");
		mkdirSync(join(dir, "phone"), { recursive: true });
		writeFileSync(join(dir, "daemon.pid"), JSON.stringify({ pid: 600, port: 1, instanceId: "x", versions: { package: "1", protocol: 1 } }));
		fakeProcess(proc, 600, ["dg", "JITWorker"], 55_000);
		const result = await longRunningJitCheck(proc, "linux").run({ ...context(dir), env: { DG_JIT: "1" } });
		expect(result.status).toBe("ok");
	});

	test("ignores a pid file whose pid now belongs to another program", async () => {
		const dir = join(root, "reused");
		const proc = join(dir, "proc");
		mkdirSync(join(dir, "phone"), { recursive: true });
		writeFileSync(join(dir, "daemon.pid"), JSON.stringify({ pid: 700, port: 1, instanceId: "x", versions: { package: "1", protocol: 1 } }));
		fakeProcess(proc, 700, ["bun", "JITWorker"], 300_000, ["/usr/bin/bun", "serve"]);
		const result = await longRunningJitCheck(proc, "linux").run(context(dir));
		expect(result).toEqual({ status: "ok", detail: "no dg daemon or phone listener is running" });
	});

	test("says nothing runs when neither process is up", async () => {
		const dir = join(root, "none");
		mkdirSync(dir, { recursive: true });
		const result = await longRunningJitCheck(join(dir, "proc"), "linux").run(context(dir));
		expect(result).toEqual({ status: "ok", detail: "no dg daemon or phone listener is running" });
	});

	test("passes off Linux, where it cannot read the state", async () => {
		const result = await longRunningJitCheck("/proc", "darwin").run(context(join(root, "none")));
		expect(result.status).toBe("ok");
	});
});
