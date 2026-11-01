import { describe, expect, test } from "bun:test";
import {
	chmodSync,
	linkSync,
	mkdirSync,
	readFileSync,
	statSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import {
	buildFilePayloads,
	ensurePrivateDir,
	MAX_UPLOAD_BYTES,
	readInput,
	restrictFile,
	writePrivate,
} from "../../../src/pw/core/files";
import { useTempScratch } from "../../../src/pw/test-support";

const scratch = useTempScratch();

describe("buildFilePayloads", () => {
	test("reads absolute and relative paths with name, mime type, and bytes", async () => {
		writeFileSync(path.join(scratch.dir, "a.png"), "A");
		writeFileSync(path.join(scratch.dir, "b.pdf"), "B");
		const payloads = await buildFilePayloads(
			[path.join(scratch.dir, "a.png"), "b.pdf"],
			scratch.dir,
		);
		expect(
			payloads.map((p) => [p.name, p.mimeType, p.buffer.toString()]),
		).toEqual([
			["a.png", "image/png", "A"],
			["b.pdf", "application/pdf", "B"],
		]);
	});

	test("falls back to octet-stream for an unknown extension", async () => {
		writeFileSync(path.join(scratch.dir, "x.unknownext"), "x");
		const [payload] = await buildFilePayloads(["x.unknownext"], scratch.dir);
		expect(payload?.mimeType).toBe("application/octet-stream");
	});

	test("rejects a file over 50 MB without reading it", async () => {
		const big = path.join(scratch.dir, "big.bin");
		writeFileSync(big, "");
		truncateSync(big, MAX_UPLOAD_BYTES + 1);
		await expect(buildFilePayloads([big], scratch.dir)).rejects.toThrow(
			`File ${big} is larger than 50 MB`,
		);
	});

	test("accepts a file of exactly 50 MB", async () => {
		const edge = path.join(scratch.dir, "edge.bin");
		writeFileSync(edge, "");
		truncateSync(edge, MAX_UPLOAD_BYTES);
		expect(await buildFilePayloads([edge], scratch.dir)).toHaveLength(1);
	});

	test("names a missing path and rejects a directory", async () => {
		const missing = path.join(scratch.dir, "nope");
		await expect(buildFilePayloads([missing], scratch.dir)).rejects.toThrow(
			`File not found: ${missing}`,
		);
		mkdirSync(path.join(scratch.dir, "dir"));
		await expect(buildFilePayloads(["dir"], scratch.dir)).rejects.toThrow(
			"Not a file:",
		);
	});
});

describe("writePrivate", () => {
	test("creates the file with mode 0600 and tightens an existing one", () => {
		const file = path.join(scratch.dir, "s.json");
		writePrivate(file, "1");
		expect(statSync(file).mode & 0o777).toBe(0o600);
		chmodSync(file, 0o644);
		writePrivate(file, "2");
		expect(statSync(file).mode & 0o777).toBe(0o600);
	});
});

describe("writePrivate replacement", () => {
	test("replaces an existing file instead of writing into it", () => {
		const file = path.join(scratch.dir, "state.json");
		const other = path.join(scratch.dir, "state-link.json");
		writeFileSync(file, "old");
		chmodSync(file, 0o644);
		linkSync(file, other);
		writePrivate(file, "secret");
		expect(readFileSync(file, "utf8")).toBe("secret");
		expect(readFileSync(other, "utf8")).toBe("old");
		expect(statSync(file).mode & 0o777).toBe(0o600);
	});
});

describe("readInput", () => {
	test("reads a relative file from the given directory and names a missing one", async () => {
		writeFileSync(path.join(scratch.dir, "c.txt"), "hello");
		expect(await readInput(scratch.dir, "c.txt")).toBe("hello");
		await expect(readInput(scratch.dir, "d.txt")).rejects.toThrow(
			`File not found: ${path.join(scratch.dir, "d.txt")}`,
		);
	});
});

describe("ensurePrivateDir", () => {
	test("creates every missing directory with mode 0700", () => {
		const leaf = path.join(scratch.dir, "a", "b", "c");
		ensurePrivateDir(leaf);
		for (const dir of ["a", "a/b", "a/b/c"]) {
			expect(statSync(path.join(scratch.dir, dir)).mode & 0o777).toBe(0o700);
		}
	});

	test("leaves an existing directory and its mode alone", () => {
		const existing = path.join(scratch.dir, "shared");
		mkdirSync(existing, { mode: 0o755 });
		chmodSync(existing, 0o755);
		ensurePrivateDir(existing);
		ensurePrivateDir(path.join(existing, "child"));
		expect(statSync(existing).mode & 0o777).toBe(0o755);
		expect(statSync(path.join(existing, "child")).mode & 0o777).toBe(0o700);
	});
});

describe("restrictFile", () => {
	test("narrows a world-readable file to 0600", () => {
		const file = path.join(scratch.dir, "open.txt");
		writeFileSync(file, "x", { mode: 0o644 });
		chmodSync(file, 0o644);
		restrictFile(file);
		expect(statSync(file).mode & 0o777).toBe(0o600);
	});
});
