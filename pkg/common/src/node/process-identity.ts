import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readProcStart } from "./plugin-cache";

const LINUX_CLOCK_TICKS_PER_SECOND = 100;

export type ProcessIdentity =
	| { kind: "dead" }
	| { kind: "unknown" }
	| { kind: "found"; args: string[]; startMs: number };

/** Argv from `/proc/<pid>/cmdline`, split on NUL. */
export function parseProcCmdline(text: string): string[] {
	return text.split("\0").filter((part) => part.length > 0);
}

/** Argv from `ps -o command=`, split on whitespace, so a path with spaces splits too. */
export function parsePsCommand(text: string): string[] {
	return text.split(/\s+/).filter((part) => part.length > 0);
}

/** Epoch ms of a `/proc/<pid>/stat` start time, from the `btime` line of `/proc/stat`; undefined when either is malformed. */
export function procStartMs(stat: string, procStatText: string): number | undefined {
	const ticks = Number(readProcStart(0, () => stat));
	const boot = /^btime\s+(\d+)$/m.exec(procStatText);
	if (!Number.isFinite(ticks) || !boot) return undefined;
	return Number(boot[1]) * 1000 + (ticks / LINUX_CLOCK_TICKS_PER_SECOND) * 1000;
}

/** Epoch ms of a `ps -o lstart=` line such as `Thu Nov  6 10:00:00 2026`, read as local time; undefined when it does not parse. */
export function parsePsStart(text: string): number | undefined {
	const ms = Date.parse(text.trim());
	return Number.isNaN(ms) ? undefined : ms;
}

function isZombieStat(stat: string): boolean {
	return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function readLinux(pid: number): ProcessIdentity {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		if (isZombieStat(stat)) return { kind: "dead" };
		const args = parseProcCmdline(readFileSync(`/proc/${pid}/cmdline`, "utf8"));
		const startMs = procStartMs(stat, readFileSync("/proc/stat", "utf8"));
		if (args.length === 0 || startMs === undefined) return { kind: "unknown" };
		return { kind: "found", args, startMs };
	} catch {
		return isAlive(pid) ? { kind: "unknown" } : { kind: "dead" };
	}
}

function ps(pid: number, field: "command" | "lstart"): string | undefined {
	const run = spawnSync("ps", ["-o", `${field}=`, "-p", String(pid)], {
		encoding: "utf8",
		env: { ...process.env, LC_ALL: "C" },
	});
	return run.error || run.status !== 0 ? undefined : run.stdout;
}

function readPs(pid: number): ProcessIdentity {
	const command = ps(pid, "command");
	const lstart = ps(pid, "lstart");
	if (command === undefined || lstart === undefined) return isAlive(pid) ? { kind: "unknown" } : { kind: "dead" };
	const args = parsePsCommand(command);
	const startMs = parsePsStart(lstart);
	if (args.length === 0 || startMs === undefined) return { kind: "unknown" };
	return { kind: "found", args, startMs };
}

/** Command line and start time of a live process on Linux (`/proc`) or macOS (`ps`); every other platform, a failed lookup or a malformed field is unknown. */
export function readProcessIdentity(pid: number, platform: NodeJS.Platform = process.platform): ProcessIdentity {
	if (!Number.isSafeInteger(pid) || pid <= 0) return { kind: "unknown" };
	if (!isAlive(pid)) return { kind: "dead" };
	if (platform === "linux") return readLinux(pid);
	if (platform === "darwin") return readPs(pid);
	return { kind: "unknown" };
}
