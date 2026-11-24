import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { readPidFile } from "@dg/common/node/pidfile";
import { type CheckResult, type DoctorCheck, type DoctorContext, ok, warn } from "./types";

export type JitState = "on" | "off" | "unknown";

const JIT_THREADS = new Set(["JITWorker", "JSCWarmUp"]);

/** JIT state of a live process, read from its Linux thread names. */
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

type Process = { label: string; pid: number; fix: string; argv: readonly string[] };

function cmdlineHas(pid: number, proc: string, words: readonly string[]): boolean {
	try {
		const args = readFileSync(join(proc, String(pid), "cmdline"), "utf8").split("\0");
		const program = basename(args[0] ?? "").replace(/\.exe$/i, "");
		return program === "dg" && words.every((word) => args.includes(word));
	} catch {
		return false;
	}
}

/** Reports the JIT state and RSS of the dg daemon and phone listener (ADR 0057). */
export function longRunningJitCheck(proc = "/proc", platform: NodeJS.Platform = process.platform): DoctorCheck {
	return {
		id: "long-running-jit",
		run(ctx): CheckResult {
			if (platform !== "linux") return ok("the JIT state is read from /proc on Linux only");
			const daemon = readPidFile(ctx.paths)?.pid;
			const listener = listenerPid(ctx);
			const candidates: Process[] = [
				...(daemon === undefined ? [] : [{ label: "daemon", pid: daemon, fix: "dg daemon restart", argv: ["serve"] }]),
				...(listener === undefined
					? []
					: [{ label: "phone listener", pid: listener, fix: "dg phone close && dg phone open", argv: ["phone", "listen"] }]),
			];
			const running = candidates
				.filter((entry) => cmdlineHas(entry.pid, proc, entry.argv))
				.map((entry) => ({ ...entry, state: jitState(entry.pid, proc), rss: rssMb(entry.pid, proc) }))
				.filter((entry) => entry.state !== "unknown");
			if (running.length === 0) return ok("no dg daemon or phone listener is running");
			const detail = running.map((entry) => `${entry.label} pid ${entry.pid}: JIT ${entry.state}, ${entry.rss}`).join("; ");
			const fixes = running.filter((entry) => entry.state === "on").map((entry) => entry.fix);
			return fixes.length > 0 && ctx.env.DG_JIT !== "1" ? warn(detail, fixes.join("; ")) : ok(detail);
		},
	};
}
