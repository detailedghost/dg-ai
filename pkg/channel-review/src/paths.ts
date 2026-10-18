import { posix, win32 } from "node:path";
import { type SystemSeams, resolveDgPaths } from "@dg/common/node";
import type { EnvName } from "./config";

export type ChannelReviewPaths = {
	env: EnvName;
	dbPath: string;
	configPath: string;
	/** Legacy JSON source, retained after import. Never written by the new store. */
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
	const dg = resolveDgPaths(seams);
	const dir = path.join(dg.stateDir, "channel-review");
	return {
		env,
		dbPath: dg.dbPath,
		configPath: path.join(dir, "config.json"),
		statePath: path.join(dir, `state.${env}.json`),
		pidPath: path.join(dir, `daemon.${env}.pid`),
		logPath: path.join(dir, `daemon.${env}.log`),
		jobsDir: path.join(dir, "jobs", env),
		workDir: path.join(dir, "work"),
	};
}
