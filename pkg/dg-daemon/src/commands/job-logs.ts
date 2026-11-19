import { DgCliError, EXIT_GENERAL_FAILURE } from "@dg/common";
import { type DgPaths, follow, readTail } from "@dg/common/node";
import { jobLogFile } from "../jobs/launcher";

const DEFAULT_LINES = 40;
const FOLLOW_POLL_MS = 500;

export type JobLogsOptions = { lines?: string; follow?: boolean };

const isMissing = (err: unknown): boolean =>
	(err as NodeJS.ErrnoException)?.code === "ENOENT";

function tailOrUndefined(path: string, count: number) {
	try {
		return readTail(path, count);
	} catch (err) {
		if (isMissing(err)) return undefined;
		throw err;
	}
}

const fail = (message: string): never => {
	throw new DgCliError(message, EXIT_GENERAL_FAILURE);
};

export async function runJobLogs(
	paths: Pick<DgPaths, "logDir">,
	name: string,
	options: JobLogsOptions,
	signal?: AbortSignal,
): Promise<void> {
	const count =
		options.lines === undefined ? DEFAULT_LINES : Number(options.lines);
	if (
		(options.lines !== undefined && !/^\d+$/.test(options.lines)) ||
		!Number.isInteger(count) ||
		count < 1
	) {
		fail("--lines must be a whole number of 1 or more");
	}
	const path = jobLogFile(paths.logDir, name);
	let start = { size: 0, ino: -1 };
	const tail = tailOrUndefined(path, count);
	if (tail) {
		for (const line of tail.lines) console.log(line);
		start = tail;
	} else if (options.follow) {
		console.error(`waiting for ${path}`);
	} else {
		fail(`no log for job "${name}" yet: ${path}`);
	}
	if (!options.follow) return;
	const controller = new AbortController();
	const stop = () => controller.abort();
	process.once("SIGINT", stop);
	signal?.addEventListener("abort", stop, { once: true });
	if (signal?.aborted) stop();
	try {
		await follow(path, {
			out: (line) => console.log(line),
			signal: controller.signal,
			pollMs: FOLLOW_POLL_MS,
			start,
		});
	} finally {
		process.off("SIGINT", stop);
	}
}
