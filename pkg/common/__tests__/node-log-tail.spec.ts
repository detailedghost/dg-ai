import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	appendFileSync,
	mkdtempSync,
	renameSync,
	rmSync,
	statSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { follow, readTail } from "../src/node/log-tail";

let dir: string;
let file: string;
const stops: AbortController[] = [];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dg-log-tail-"));
	file = join(dir, "job.log");
});

afterEach(() => {
	for (const controller of stops.splice(0)) controller.abort();
	rmSync(dir, { recursive: true, force: true });
});

const numbered = (count: number) =>
	Array.from({ length: count }, (_, i) => `line ${i + 1}`);
const body = (rows: string[]) => `${rows.join("\n")}\n`;

async function until(check: () => boolean, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return;
		await Bun.sleep(10);
	}
	throw new Error("condition not met in time");
}

function startFollow(start: { size: number; ino: number }) {
	const out: string[] = [];
	const controller = new AbortController();
	stops.push(controller);
	const done = follow(file, {
		out: (line: string) => out.push(line),
		signal: controller.signal,
		pollMs: 10,
		start,
	});
	return { out, done, stop: () => controller.abort() };
}

describe("readTail", () => {
	it("returns the last count lines", () => {
		writeFileSync(file, body(numbered(10)));

		expect(readTail(file, 3).lines).toEqual(numbered(10).slice(-3));
	});

	it("returns each line of a file with fewer lines than count", () => {
		writeFileSync(file, body(numbered(3)));

		expect(readTail(file, 40).lines).toEqual(numbered(3));
	});

	it("returns no lines for an empty file", () => {
		writeFileSync(file, "");

		const tail = readTail(file, 5);

		expect(tail.lines).toEqual([]);
		expect(tail.size).toBe(0);
	});

	it("leaves a last line with no newline out of the tail and of the size", () => {
		writeFileSync(file, "one\ntwo\npart");

		const tail = readTail(file, 5);

		expect(tail.lines).toEqual(["one", "two"]);
		expect(tail.size).toBe(Buffer.byteLength("one\ntwo\n"));
	});

	it("returns the last lines of a 20 MB file that spans many read blocks", () => {
		const row = `${"x".repeat(99)}\n`;
		writeFileSync(file, row.repeat(200_000) + body(numbered(5)));

		const tail = readTail(file, 5);

		expect(tail.lines).toEqual(numbered(5));
		expect(tail.size).toBe(statSync(file).size);
	});

	it("returns a line that crosses a block boundary whole", () => {
		const long = "y".repeat(70_000);
		writeFileSync(file, `${long}\nshort\n`);

		expect(readTail(file, 2).lines).toEqual([long, "short"]);
		expect(readTail(file, 1).lines).toEqual(["short"]);
	});

	it.each([-2, -1, 0, 1, 2])(
		"returns each line whole when a newline sits %i bytes from a 64 KiB block boundary",
		(shift) => {
			const long = "x".repeat(64 * 1024 - 1 + shift);
			writeFileSync(file, `${long}\ntail\n`);

			expect(readTail(file, 2).lines).toEqual([long, "tail"]);
			expect(readTail(file, 1).lines).toEqual(["tail"]);
			expect(readTail(file, 2).size).toBe(statSync(file).size);
		},
	);

	it("leaves out a last line with no newline that is longer than a block", () => {
		writeFileSync(file, `one\ntwo\n${"y".repeat(2 * 64 * 1024 + 10)}`);

		const tail = readTail(file, 5);

		expect(tail.lines).toEqual(["one", "two"]);
		expect(tail.size).toBe(Buffer.byteLength("one\ntwo\n"));
	});

	it.each([10, 200_000])(
		"returns no lines and size 0 for a file of %i bytes with no newline",
		(length) => {
			writeFileSync(file, "z".repeat(length));

			const tail = readTail(file, 3);

			expect(tail.lines).toEqual([]);
			expect(tail.size).toBe(0);
		},
	);

	it("returns each line when count equals the line count", () => {
		writeFileSync(file, body(numbered(10)));
		const wide = Array.from({ length: 4 }, (_, i) => `${i}${"w".repeat(40_000)}`);
		const wideFile = join(dir, "wide.log");
		writeFileSync(wideFile, body(wide));

		expect(readTail(file, 10).lines).toEqual(numbered(10));
		expect(readTail(wideFile, 4).lines).toEqual(wide);
	});

	it("returns the inode of the file it read", () => {
		writeFileSync(file, "one\n");

		expect(readTail(file, 1).ino).toBe(statSync(file).ino);
	});

	it("counts bytes, not characters, for the size", () => {
		writeFileSync(file, "café\n");

		expect(readTail(file, 1).size).toBe(Buffer.byteLength("café\n"));
		expect(readTail(file, 1).lines).toEqual(["café"]);
	});
});

describe("follow", () => {
	it("prints each line that is appended after the start offset", async () => {
		writeFileSync(file, body(numbered(2)));
		const { out, done, stop } = startFollow(readTail(file, 2));

		appendFileSync(file, "three\nfour\n");
		await until(() => out.length === 2);
		stop();
		await done;

		expect(out).toEqual(["three", "four"]);
	});

	it("resolves when the signal is aborted", async () => {
		writeFileSync(file, "one\n");
		const { done, stop } = startFollow(readTail(file, 1));

		stop();

		await expect(done).resolves.toBeUndefined();
	});

	it("holds a last line with no newline and prints it one time when the newline arrives", async () => {
		writeFileSync(file, "one\npart");
		const { out, done, stop } = startFollow(readTail(file, 5));
		await Bun.sleep(80);
		expect(out).toEqual([]);

		appendFileSync(file, "ial\n");
		await until(() => out.length === 1);
		await Bun.sleep(80);
		stop();
		await done;

		expect(out).toEqual(["partial"]);
	});

	it("starts from the first byte of a file that does not exist yet", async () => {
		const { out, done, stop } = startFollow({ size: 0, ino: -1 });
		await Bun.sleep(50);

		writeFileSync(file, "first\nsecond\n");
		await until(() => out.length === 2);
		stop();
		await done;

		expect(out).toEqual(["first", "second"]);
	});

	it("continues after a copy-truncate rotation", async () => {
		writeFileSync(file, body(numbered(5)));
		const { out, done, stop } = startFollow(readTail(file, 5));

		truncateSync(file, 0);
		appendFileSync(file, "after\n");
		await until(() => out.includes("after"));
		stop();
		await done;

		expect(out).toEqual(["after"]);
	});

	it("reads a replaced file from its first byte", async () => {
		writeFileSync(file, body(numbered(3)));
		const { out, done, stop } = startFollow(readTail(file, 3));

		renameSync(file, join(dir, "job.log.1"));
		writeFileSync(file, `${body(numbered(3))}`);
		await until(() => out.length === 3);
		stop();
		await done;

		expect(out).toEqual(numbered(3));
	});

	it("drops a held partial line when the file is truncated", async () => {
		writeFileSync(file, "one\npart");
		const { out, done, stop } = startFollow(readTail(file, 5));
		await Bun.sleep(50);

		truncateSync(file, 0);
		appendFileSync(file, "new\n");
		await until(() => out.length === 1);
		stop();
		await done;

		expect(out).toEqual(["new"]);
	});

	it("keeps a character that is split across two writes whole", async () => {
		writeFileSync(file, "");
		const { out, done, stop } = startFollow(readTail(file, 1));
		const bytes = Buffer.from("café\n");

		appendFileSync(file, bytes.subarray(0, 4));
		await Bun.sleep(80);
		appendFileSync(file, bytes.subarray(4));
		await until(() => out.length === 1);
		stop();
		await done;

		expect(out).toEqual(["café"]);
	});

	it("drops a held partial multibyte character when the file is truncated", async () => {
		writeFileSync(file, Buffer.concat([Buffer.from("a\n"), Buffer.from([0xc3])]));
		const { out, done, stop } = startFollow(readTail(file, 1));
		await Bun.sleep(100);

		truncateSync(file, 0);
		await Bun.sleep(100);
		appendFileSync(file, "ok\n");
		await until(() => out.length === 1);
		stop();
		await done;

		expect(out).toEqual(["ok"]);
	});
});
