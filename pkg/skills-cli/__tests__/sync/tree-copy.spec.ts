import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyTree, isSymlink, readlinkSafe, rewriteTreeScratchPaths } from "../../src/sync/tree-copy";

const tmpDirs: string[] = [];

afterEach(() => {
	for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function withTmp(): string {
	const d = mkdtempSync(join(tmpdir(), "tree-copy-test-"));
	tmpDirs.push(d);
	return d;
}

describe("copyTree", () => {
	test("copies nested files and directories", () => {
		const dir = withTmp();
		const from = join(dir, "from");
		const to = join(dir, "to");
		mkdirSync(join(from, "nested"), { recursive: true });
		writeFileSync(join(from, "top.txt"), "top");
		writeFileSync(join(from, "nested", "deep.txt"), "deep");

		copyTree(from, to);

		expect(readFileSync(join(to, "top.txt"), "utf8")).toBe("top");
		expect(readFileSync(join(to, "nested", "deep.txt"), "utf8")).toBe("deep");
	});

	test("skips symlinks instead of following them", () => {
		const dir = withTmp();
		const from = join(dir, "from");
		const to = join(dir, "to");
		const outside = join(dir, "outside.txt");
		writeFileSync(outside, "outside content");
		mkdirSync(from, { recursive: true });
		symlinkSync(outside, join(from, "link.txt"));
		writeFileSync(join(from, "real.txt"), "real");

		copyTree(from, to);

		expect(existsSync(join(to, "link.txt"))).toBe(false);
		expect(readFileSync(join(to, "real.txt"), "utf8")).toBe("real");
	});
});

describe("rewriteTreeScratchPaths", () => {
	test("rewrites a scratch literal in every text file under a tree", () => {
		const dir = withTmp();
		mkdirSync(join(dir, "nested"), { recursive: true });
		writeFileSync(join(dir, "top.md"), "Scratch: /tmp/claude/x");
		writeFileSync(join(dir, "nested", "deep.md"), "Also /tmp/claude/y here");

		rewriteTreeScratchPaths(dir, { AI_SCRATCH_DIR: "/tmp/ai" });

		expect(readFileSync(join(dir, "top.md"), "utf8")).toBe("Scratch: /tmp/ai/x");
		expect(readFileSync(join(dir, "nested", "deep.md"), "utf8")).toBe("Also /tmp/ai/y here");
	});

	test("leaves a binary file untouched", () => {
		const dir = withTmp();
		const binPath = join(dir, "image.bin");
		const buf = Buffer.from([0, 1, 2, 3, 0, 255]);
		writeFileSync(binPath, buf);

		rewriteTreeScratchPaths(dir, { AI_SCRATCH_DIR: "/tmp/ai" });

		expect(readFileSync(binPath).equals(buf)).toBe(true);
	});

	test("leaves a file with no scratch literal unchanged on disk (no needless write)", () => {
		const dir = withTmp();
		const filePath = join(dir, "plain.md");
		writeFileSync(filePath, "nothing to rewrite here");
		const before = readFileSync(filePath, "utf8");

		rewriteTreeScratchPaths(dir, { AI_SCRATCH_DIR: "/tmp/ai" });

		expect(readFileSync(filePath, "utf8")).toBe(before);
	});
});

describe("isSymlink / readlinkSafe", () => {
	test("isSymlink is true for a symlink and false for a real directory", () => {
		const dir = withTmp();
		const real = join(dir, "real");
		const link = join(dir, "link");
		mkdirSync(real);
		symlinkSync(real, link);
		expect(isSymlink(link)).toBe(true);
		expect(isSymlink(real)).toBe(false);
	});

	test("readlinkSafe returns the target for a symlink and null otherwise", () => {
		const dir = withTmp();
		const real = join(dir, "real");
		const link = join(dir, "link");
		mkdirSync(real);
		symlinkSync(real, link);
		expect(readlinkSafe(link)).toBe(real);
		expect(readlinkSafe(real)).toBeNull();
		expect(readlinkSafe(join(dir, "missing"))).toBeNull();
	});
});
