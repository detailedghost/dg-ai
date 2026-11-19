import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { wait } from "../async";

export type LogTail = { lines: string[]; size: number; ino: number };

export type FollowOptions = {
	out: (line: string) => void;
	signal?: AbortSignal;
	pollMs: number;
	start: { size: number; ino: number };
};

const BLOCK_BYTES = 64 * 1024;
const FOLLOW_READ_BYTES = 1024 * 1024;

function readBytes(fd: number, from: number, to: number): Buffer {
	const buffer = Buffer.alloc(Math.max(0, to - from));
	const read = readSync(fd, buffer, 0, buffer.length, from);
	return buffer.subarray(0, read);
}

function countNewlines(block: Buffer, limit: number): number {
	let count = 0;
	for (let at = block.indexOf(0x0a); at !== -1 && at < limit; at = block.indexOf(0x0a, at + 1)) {
		count += 1;
	}
	return count;
}

/** Last `count` whole lines; `size` ends after the last newline, so a half-written line is left out. */
export function readTail(path: string, count: number): LogTail {
	const fd = openSync(path, "r");
	try {
		const stat = fstatSync(fd);
		const blocks: Buffer[] = [];
		let end = -1;
		let newlines = 0;
		let from = stat.size;
		while (from > 0 && newlines < count + 1) {
			const start = Math.max(0, from - BLOCK_BYTES);
			const block = readBytes(fd, start, from);
			blocks.unshift(block);
			from = start;
			if (end === -1) {
				const last = block.lastIndexOf(0x0a);
				if (last === -1) continue;
				end = start + last + 1;
				newlines += countNewlines(block, last + 1);
			} else {
				newlines += countNewlines(block, block.length);
			}
		}
		if (end === -1) return { lines: [], size: 0, ino: stat.ino };
		const text = Buffer.concat(blocks).subarray(0, end - from).toString("utf8");
		const lines = text.split("\n");
		lines.pop();
		return { lines: lines.slice(-count), size: end, ino: stat.ino };
	} finally {
		closeSync(fd);
	}
}

function readNew(
	path: string,
	state: { offset: number; ino: number; pending: string; decoder: StringDecoder },
): Buffer | undefined {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		return undefined;
	}
	try {
		const stat = fstatSync(fd);
		if (stat.ino !== state.ino || stat.size < state.offset) {
			state.offset = 0;
			state.pending = "";
			state.decoder.end();
			state.ino = stat.ino;
		}
		return readBytes(fd, state.offset, Math.min(stat.size, state.offset + FOLLOW_READ_BYTES));
	} finally {
		closeSync(fd);
	}
}

/** Prints each new whole line until `signal` aborts; starts again at byte 0 after a rotation or a new file. */
export async function follow(path: string, options: FollowOptions): Promise<void> {
	const { out, signal, pollMs } = options;
	const state = {
		offset: options.start.size,
		ino: options.start.ino,
		pending: "",
		decoder: new StringDecoder("utf8"),
	};
	let backlog = false;
	while (!signal?.aborted) {
		if (!backlog) await wait(pollMs);
		if (signal?.aborted) break;
		const chunk = readNew(path, state);
		backlog = chunk?.length === FOLLOW_READ_BYTES;
		if (!chunk || chunk.length === 0) continue;
		state.offset += chunk.length;
		const parts = (state.pending + state.decoder.write(chunk)).split("\n");
		state.pending = parts.pop() ?? "";
		for (const line of parts) out(line);
	}
}
