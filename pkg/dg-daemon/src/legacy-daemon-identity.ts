import { statSync } from "node:fs";
import { type ProcessIdentity, readProcessIdentity } from "@dg/common/node/process-identity";

export type DaemonIdentity = "ours" | "foreign" | "unknown";

const PID_FILE_START_SLACK_MS = 2000;
const DAEMON_ARG = /(^|[\\/])dg-daemon([\\/.]|$)/;

/** True for the argv of a `dg-daemon __serve` process, however it was launched. */
export function isDaemonServeArgs(args: readonly string[]): boolean {
	return args.includes("__serve") && args.some((arg) => DAEMON_ARG.test(arg));
}

/** Ours needs a dg-daemon serve command line and a start no later than the pid file write, give or take the slack. */
export function daemonIdentity(identity: ProcessIdentity, pidFileMtimeMs: number | undefined): DaemonIdentity {
	if (identity.kind === "dead") return "foreign";
	if (identity.kind === "unknown") return "unknown";
	if (!isDaemonServeArgs(identity.args)) return "foreign";
	if (pidFileMtimeMs === undefined) return "unknown";
	return identity.startMs <= pidFileMtimeMs + PID_FILE_START_SLACK_MS ? "ours" : "foreign";
}

function pidFileMtimeMs(pidFile: string): number | undefined {
	try {
		return statSync(pidFile).mtimeMs;
	} catch {
		return undefined;
	}
}

/** Whether `pid` is the dg daemon that wrote `pidFile`, not a process that reused the pid. */
export function isOurDaemon(pid: number, pidFile: string): DaemonIdentity {
	return daemonIdentity(readProcessIdentity(pid), pidFileMtimeMs(pidFile));
}
