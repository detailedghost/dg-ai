import { describeError } from "@dg/common";
import {
	follow,
	type LogTail,
	readTail,
	type SystemSeams,
} from "@dg/common/node";
import { channelReviewPaths } from "../paths";
import { assertEnvName, type DaemonIo, savedEnvName } from "./shared";

const DEFAULT_LINES = 40;
const FOLLOW_POLL_MS = 500;

type LogsOptions = { env?: string; lines?: number; follow?: boolean };

type LogsSeams = {
	io: DaemonIo;
	system?: SystemSeams;
	signal?: AbortSignal;
	pollIntervalMs?: number;
};

export async function logs(
	options: LogsOptions,
	seams: LogsSeams,
): Promise<number> {
	const { io, signal } = seams;
	const system = seams.system ?? {};
	const count = options.lines ?? DEFAULT_LINES;
	if (!Number.isInteger(count) || count < 1) {
		io.err("--lines must be a whole number of 1 or more");
		return 1;
	}
	let path: string;
	try {
		const name = assertEnvName(options.env ?? savedEnvName(system));
		path = channelReviewPaths(name, system).logPath;
	} catch (error) {
		io.err(describeError(error));
		return 1;
	}
	let tail: LogTail;
	try {
		tail = readTail(path, count);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		io.out(`${path}: no log yet`);
		return 0;
	}
	for (const line of tail.lines) io.out(line);
	if (options.follow) {
		await follow(path, {
			out: io.out,
			signal,
			pollMs: seams.pollIntervalMs ?? FOLLOW_POLL_MS,
			start: tail,
		});
	}
	return 0;
}
