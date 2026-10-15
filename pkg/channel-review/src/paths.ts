import { posix, win32 } from "node:path";
import { type SystemSeams, resolveDgPaths } from "@dg/common/node";
import type { EnvName } from "./config";

export type ChannelReviewPaths = {
	configPath: string;
	statePath: string;
	pidPath: string;
	logPath: string;
	jobsDir: string;
	workDir: string;
};

export function channelReviewPaths(
	env: EnvName,
	seams: SystemSeams = {},
): ChannelReviewPaths {
	const path = (seams.platform ?? process.platform) === "win32" ? win32 : posix;
	const dir = path.join(resolveDgPaths(seams).stateDir, "channel-review");
	return {
		configPath: path.join(dir, "config.json"),
		statePath: path.join(dir, `state.${env}.json`),
		pidPath: path.join(dir, `daemon.${env}.pid`),
		logPath: path.join(dir, `daemon.${env}.log`),
		jobsDir: path.join(dir, "jobs", env),
		workDir: path.join(dir, "work"),
	};
}
