import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readPidFile } from "@dg/common/node/pidfile";
import { type CheckResult, type DoctorCheck, type DoctorContext, ok, warn } from "./types";

export type JitState = "on" | "off" | "unknown";

const JIT_THREADS = new Set(["JITWorker", "JSCWarmUp"]);

/** JIT state of a live process from its Linux thread names: JSC starts JIT worker threads only when the JIT is on. */
export function jitState(pid: number, proc = "/proc"): JitState {
	try {
		const tasks = readdirSync(join(proc, String(pid), "task"));
		const names = tasks.map((task) => readFileSync(join(proc, String(pid), "task", task, "comm"), "utf8").trim());
		return names.some((name) => JIT_THREADS.has(name)) ? "on" : "off";
	} catch {
		return "unknown";
	}
}

function rssMb(pid: number, proc: string): string {
	try {
		const kb = Number(readFileSync(join(proc, String(pid), "status"), "utf8").match(/VmRSS:\s+(\d+)/)?.[1]);
		return Number.isFinite(kb) ? `${(kb / 1024).toFixed(1)} MB` : "unknown RSS";
	} catch {
		return "unknown RSS";
	}
}

function listenerPid(ctx: DoctorContext): number | undefined {
	try {
		const pid = (JSON.parse(readFileSync(join(ctx.paths.phoneRoot, "listener.pid"), "utf8")) as { pid?: unknown }).pid;
		return typeof pid === "number" ? pid : undefined;
	} catch {
		return undefined;
	}
}

type Process = { label: string; pid: number; fix: string };

/** Reports whether the daemon and the phone listener run without the JIT, as ADR 0057 intends, with their RSS. */
export function longRunningJitCheck(proc = "/proc", platform: NodeJS.Platform = process.platform): DoctorCheck {
	return {
		id: "long-running-jit",
		run(ctx): CheckResult {
			if (platform !== "linux") return ok("the JIT state is read from /proc on Linux only");
			const daemon = readPidFile(ctx.paths)?.pid;
			const listener = listenerPid(ctx);
			const running: Process[] = [
				...(daemon === undefined ? [] : [{ label: "daemon", pid: daemon, fix: "dg daemon restart" }]),
				...(listener === undefined ? [] : [{ label: "phone listener", pid: listener, fix: "dg phone close && dg phone open" }]),
			].filter((entry) => jitState(entry.pid, proc) !== "unknown");
			if (running.length === 0) return ok("no dg daemon or phone listener is running");
			const detail = running.map((entry) => `${entry.label} pid ${entry.pid}: JIT ${jitState(entry.pid, proc)}, ${rssMb(entry.pid, proc)}`).join("; ");
			const jitOn = running.find((entry) => jitState(entry.pid, proc) === "on");
			return jitOn && ctx.env.DG_JIT !== "1" ? warn(detail, jitOn.fix) : ok(detail);
		},
	};
}
