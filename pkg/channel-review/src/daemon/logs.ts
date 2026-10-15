import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { describeError, wait } from "@dg/common";
import type { SystemSeams } from "@dg/common/node";
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

function readRange(path: string, from: number, to: number): Buffer {
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.alloc(to - from);
		const read = readSync(fd, buffer, 0, buffer.length, from);
		return buffer.subarray(0, read);
	} finally {
		closeSync(fd);
	}
}

async function follow(
	path: string,
	io: DaemonIo,
	signal: AbortSignal | undefined,
	pollMs: number,
	start: { size: number; ino: number },
): Promise<void> {
	const decoder = new StringDecoder("utf8");
	let offset = start.size;
	let ino = start.ino;
	let pending = "";
	while (!signal?.aborted) {
		await wait(pollMs);
		if (!existsSync(path)) continue;
		const stat = statSync(path);
		if (stat.ino !== ino || stat.size < offset) {
			offset = 0;
			pending = "";
			ino = stat.ino;
		}
		if (stat.size === offset) continue;
		const chunk = readRange(path, offset, stat.size);
		offset += chunk.length;
		const parts = (pending + decoder.write(chunk)).split("\n");
		pending = parts.pop() ?? "";
		for (const line of parts) io.out(line);
	}
}

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
	if (!existsSync(path)) {
		io.out(`${path}: no log yet`);
		return 0;
	}
	const text = readFileSync(path, "utf8");
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	for (const line of lines.slice(-count)) io.out(line);
	if (options.follow) {
		const { ino } = statSync(path);
		await follow(path, io, signal, seams.pollIntervalMs ?? FOLLOW_POLL_MS, {
			size: Buffer.byteLength(text),
			ino,
		});
	}
	return 0;
}
