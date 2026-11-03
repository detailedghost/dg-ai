import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
});
