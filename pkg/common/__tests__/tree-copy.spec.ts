import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyTree, treeContained, treeMatches } from "@dg/common/node";

let dir: string;
let from: string;
let to: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dg-tree-copy-"));
	from = join(dir, "from");
	to = join(dir, "to");
	mkdirSync(join(from, "sub"), { recursive: true, mode: 0o700 });
	writeFileSync(join(from, "sub", "run"), "#!/bin/sh\n", { mode: 0o755 });
	symlinkSync("sub", join(from, "relative"));
	symlinkSync(join(from, "sub"), join(from, "absolute"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(process.platform === "win32")("copyTree", () => {
	it("keeps modes and relative links and rebases an absolute link into the copy", () => {
		copyTree(from, to);

		expect(statSync(join(to, "sub")).mode & 0o777).toBe(0o700);
		expect(statSync(join(to, "sub", "run")).mode & 0o777).toBe(0o755);
		expect(readlinkSync(join(to, "relative"))).toBe("sub");
		expect(readlinkSync(join(to, "absolute"))).toBe(join(to, "sub"));
		expect(treeMatches(from, to)).toBe(true);
	});

	it("reports a mismatch when a copied file changes size", () => {
		copyTree(from, to);
		writeFileSync(join(to, "sub", "run"), "longer contents");

		expect(treeMatches(from, to)).toBe(false);
	});

	it("copies a self-referencing link as a link", () => {
		symlinkSync("loop", join(from, "loop"));

		copyTree(from, to);

		expect(readlinkSync(join(to, "loop"))).toBe("loop");
		expect(treeMatches(from, to)).toBe(true);
	});

	it("matches a copied link written as an absolute path to the same target", () => {
		copyTree(from, to);
		rmSync(join(to, "relative"));
		symlinkSync(join(to, "sub"), join(to, "relative"));

		expect(treeMatches(from, to)).toBe(true);
	});

	it("counts a copy that gained files and moved a link as still holding every source file", () => {
		copyTree(from, to);
		writeFileSync(join(to, "sub", "new"), "added later");
		rmSync(join(to, "relative"));
		symlinkSync("elsewhere", join(to, "relative"));

		expect(treeMatches(from, to)).toBe(false);
		expect(treeContained(from, to)).toBe(true);
	});

	it("does not count a copy that lost a source file or changed its size", () => {
		copyTree(from, to);
		writeFileSync(join(to, "sub", "run"), "#!/bin/sh\necho changed\n");

		expect(treeContained(from, to)).toBe(false);
		rmSync(join(to, "sub", "run"));
		expect(treeContained(from, to)).toBe(false);
	});

	it("reports a mismatch when a source file changes to other bytes of the same size", () => {
		copyTree(from, to);
		writeFileSync(join(from, "sub", "run"), "#!/bin/zz\n");

		expect(treeMatches(from, to)).toBe(false);
		expect(treeContained(from, to)).toBe(false);
	});

	it("copies the files inside a read-only folder and keeps its mode", () => {
		mkdirSync(join(from, "locked"));
		writeFileSync(join(from, "locked", "note"), "kept");
		chmodSync(join(from, "locked"), 0o555);
		try {
			copyTree(from, to);

			expect(readFileSync(join(to, "locked", "note"), "utf8")).toBe("kept");
			expect(statSync(join(to, "locked")).mode & 0o777).toBe(0o555);
			expect(treeMatches(from, to)).toBe(true);
		} finally {
			chmodSync(join(from, "locked"), 0o755);
			try {
				chmodSync(join(to, "locked"), 0o755);
			} catch {}
		}
	});

	it("compares empty files and files that end on and past a 1 MiB chunk", () => {
		const mib = 1 << 20;
		writeFileSync(join(from, "empty"), "");
		writeFileSync(join(from, "exact"), Buffer.alloc(mib, 1));
		writeFileSync(join(from, "partial"), Buffer.alloc(mib + 7, 2));
		copyTree(from, to);
		expect(treeMatches(from, to)).toBe(true);

		for (const name of ["exact", "partial"]) {
			const bytes = Buffer.alloc(name === "exact" ? mib : mib + 7, name === "exact" ? 1 : 2);
			bytes[bytes.length - 1] = 9;
			writeFileSync(join(to, name), bytes);
			expect([name, treeMatches(from, to)]).toEqual([name, false]);
			copyTree(join(from, name), join(dir, `fresh-${name}`));
			rmSync(join(to, name));
			copyTree(join(dir, `fresh-${name}`), join(to, name));
		}
		expect(treeMatches(from, to)).toBe(true);
	});
});
