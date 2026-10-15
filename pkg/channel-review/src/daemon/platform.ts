import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAlive, killProcessTree } from "@dg/common/node";
import type { ProcessSeam } from "../engine";

export type PlatformSeam = {
	platform: NodeJS.Platform;
	listArgs(pid: number): string;
	startTime(pid: number): string | undefined;
	killTree(pid: number): void | Promise<void>;
	signal(pid: number, signal: NodeJS.Signals | 0): void;
};

const COMMAND_TIMEOUT_MS = 10_000;
const PROC_START_FIELD = 22;

function pidArg(pid: number): string {
	return String(Math.trunc(pid));
}

function procStartTime(pid: number): string | undefined {
	try {
		const stat = readFileSync(`/proc/${pidArg(pid)}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		return fields[PROC_START_FIELD - 3] || undefined;
	} catch {
		return undefined;
	}
}

function output(command: string, args: string[]): string | undefined {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		timeout: COMMAND_TIMEOUT_MS,
		windowsHide: true,
	});
	const text = typeof result.stdout === "string" ? result.stdout.trim() : "";
	return text === "" ? undefined : text;
}

export function createSystemPlatform(): PlatformSeam {
	const platform = process.platform;
	const win32 = platform === "win32";
	return {
		platform,
		listArgs(pid) {
			return (
				(win32
					? output("powershell.exe", [
							"-NoProfile",
							"-NonInteractive",
							"-Command",
							`(Get-CimInstance Win32_Process -Filter "ProcessId=${pidArg(pid)}").CommandLine`,
						])
					: output("ps", ["-o", "args=", "-p", pidArg(pid)])) ?? ""
			);
		},
		startTime(pid) {
			if (win32) {
				return output("powershell.exe", [
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					`(Get-Process -Id ${pidArg(pid)}).StartTime.ToUniversalTime().Ticks`,
				]);
			}
			return procStartTime(pid) ?? output("ps", ["-o", "lstart=", "-p", pidArg(pid)]);
		},
		killTree(pid) {
			killProcessTree(pid, { platform });
		},
		signal(pid, signal) {
			process.kill(pid, signal);
		},
	};
}

export function platformAlive(pid: number, platform: PlatformSeam): boolean {
	return isAlive(pid, (target, signal) => platform.signal(target, signal));
}

export function sendSignal(
	pid: number,
	signal: NodeJS.Signals,
	platform: PlatformSeam,
): void {
	try {
		platform.signal(pid, signal);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

export function processSeam(platform: PlatformSeam): ProcessSeam {
	return {
		isAlive: (pid) => platformAlive(pid, platform),
		listArgs: (pid) => platform.listArgs(pid),
		startTime: (pid) => platform.startTime(pid),
		killTree: (pid) => platform.killTree(pid),
	};
}
