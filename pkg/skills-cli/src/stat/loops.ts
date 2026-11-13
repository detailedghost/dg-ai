import { closeSync, openSync, readSync, statSync } from "node:fs";
import { isPathInside } from "@dg/common/node";

/** The fields of a `dg-skills bg` job that the stall check reads. */
export interface JobView {
	id: string;
	state: string;
	cwd: string;
	startedAt: string;
	logFile: string;
}

export interface StalledJob {
	id: string;
	reason: "no log growth" | "past max age";
	idleMinutes: number;
	ageMinutes: number;
	logFile: string;
	lastLine: string;
}

export interface LoopOptions {
	cwd: string;
	now: number;
	stallMinutes: number;
	maxAgeMinutes: number;
	logMtime: (file: string) => number | null;
	lastLine: (file: string) => string;
}

/** Running jobs under `cwd` whose log stopped growing or that ran past the max age. */
export function findStalled(jobs: JobView[], options: LoopOptions): StalledJob[] {
	const out: StalledJob[] = [];
	for (const job of jobs) {
		if (job.state !== "running" || !isPathInside(job.cwd, options.cwd)) continue;
		const started = Date.parse(job.startedAt);
		const ageMinutes = Number.isNaN(started) ? 0 : Math.floor((options.now - started) / 60_000);
		const touched = options.logMtime(job.logFile) ?? started;
		const idleMinutes = Number.isNaN(touched) ? 0 : Math.floor((options.now - touched) / 60_000);
		const reason =
			idleMinutes >= options.stallMinutes
				? "no log growth"
				: ageMinutes >= options.maxAgeMinutes
					? "past max age"
					: null;
		if (!reason) continue;
		out.push({ id: job.id, reason, idleMinutes, ageMinutes, logFile: job.logFile, lastLine: options.lastLine(job.logFile) });
	}
	return out;
}

/** Modification time of a file in ms, or null when it cannot be read. */
export function fileMtime(file: string): number | null {
	try {
		return statSync(file).mtimeMs;
	} catch {
		return null;
	}
}

/** Last non-empty line of a file's final 4 KiB, without control characters and capped at 200 characters. */
export function lastLogLine(file: string): string {
	let fd: number | undefined;
	try {
		fd = openSync(file, "r");
		const size = statSync(file).size;
		const length = Math.min(size, 4096);
		const buffer = Buffer.alloc(length);
		readSync(fd, buffer, 0, length, size - length);
		const lines = buffer
			.toString("utf8")
			.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
			.split(/\r?\n|\r/)
			.map((line) => line.replace(/[\u0000-\u001f\u007f]/g, "").trim())
			.filter(Boolean);
		return (lines.at(-1) ?? "").slice(0, 200);
	} catch {
		return "";
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
