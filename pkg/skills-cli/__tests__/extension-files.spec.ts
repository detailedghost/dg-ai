import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	legacyExtensionDirs,
	removeLegacyExtensions,
	syncDirInPlace,
} from "../src/utils/extension-files";

const roots: string[] = [];

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "dg-ext-files-"));
	roots.push(dir);
	return dir;
}

function put(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

afterEach(() => {
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("syncDirInPlace", () => {
	test("refuses a symlinked destination and leaves its target untouched", () => {
		const root = scratch();
		const src = join(root, "src");
		const target = join(root, "target");
		put(join(src, "a.js"), "new");
		put(join(target, "keep.txt"), "keep");
		symlinkSync(target, join(root, "dest"));
		expect(() => syncDirInPlace(src, join(root, "dest"))).toThrow(
			"symlink",
		);
		expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("keep");
		expect(existsSync(join(target, "a.js"))).toBe(false);
	});

	test("refuses a source symlink instead of copying its target", () => {
		const root = scratch();
		const src = join(root, "src");
		const secret = join(root, "secret.txt");
		put(secret, "secret");
		mkdirSync(src, { recursive: true });
		symlinkSync(secret, join(src, "link.js"));
		expect(() => syncDirInPlace(src, join(root, "dest"))).toThrow(
			"not a regular file",
		);
		expect(existsSync(join(root, "dest", "link.js"))).toBe(false);
	});

	test("keeps the destination directory itself and replaces, adds and removes files", () => {
		const root = scratch();
		const src = join(root, "src");
		const dest = join(root, "dest");
		put(join(src, "manifest.json"), "new manifest");
		put(join(src, "assets/new.js"), "new asset");
		put(join(dest, "manifest.json"), "old manifest");
		put(join(dest, "stale.js"), "stale");
		put(join(dest, "gone/deep/old.js"), "old");
		const inodeBefore = statSync(dest).ino;

		syncDirInPlace(src, dest);

		expect(statSync(dest).ino).toBe(inodeBefore);
		expect(readFileSync(join(dest, "manifest.json"), "utf8")).toBe("new manifest");
		expect(readFileSync(join(dest, "assets/new.js"), "utf8")).toBe("new asset");
		expect(existsSync(join(dest, "stale.js"))).toBe(false);
		expect(existsSync(join(dest, "gone"))).toBe(false);
	});

	test("creates the destination when it does not exist", () => {
		const root = scratch();
		const src = join(root, "src");
		put(join(src, "a/b.txt"), "x");

		syncDirInPlace(src, join(root, "fresh"));

		expect(readFileSync(join(root, "fresh/a/b.txt"), "utf8")).toBe("x");
	});

	test("never renames or removes the live directory, and only renames files inside it", () => {
		const root = scratch();
		const src = join(root, "src");
		const dest = join(root, "dest");
		put(join(src, "one.js"), "1");
		put(join(dest, "one.js"), "0");
		const renames: [string, string][] = [];

		syncDirInPlace(src, dest, {
			rename(from, to) {
				renames.push([from, to]);
				renameSync(from, to);
			},
		});

		expect(renames.length).toBeGreaterThan(0);
		for (const [from, to] of renames) {
			expect(from).not.toBe(dest);
			expect(to).not.toBe(dest);
			expect(from.startsWith(`${dest}/`)).toBe(true);
			expect(dirname(from)).toBe(dirname(to));
		}
	});

	test("leaves no temporary files behind", () => {
		const root = scratch();
		const src = join(root, "src");
		const dest = join(root, "dest");
		put(join(src, "one.js"), "1");

		syncDirInPlace(src, dest);

		expect(Bun.spawnSync(["ls", "-A", dest]).stdout.toString().trim()).toBe("one.js");
	});

	test("replaces a stale file whose type changed to a directory", () => {
		const root = scratch();
		const src = join(root, "src");
		const dest = join(root, "dest");
		put(join(src, "x/inner.js"), "1");
		put(join(dest, "x"), "was a file");

		syncDirInPlace(src, dest);

		expect(readFileSync(join(dest, "x/inner.js"), "utf8")).toBe("1");
	});
});

describe("legacy extension cleanup", () => {
	const names = [
		"browser-batch-extension",
		"dg-ai-browser-batch-chrome",
		"dg-ai-browser-batch-firefox",
	];

	test("removes the three legacy folders only when the manifest name matches exactly", () => {
		const dgDir = join(scratch(), ".dg");
		for (const name of names) {
			put(join(dgDir, name, "manifest.json"), JSON.stringify({ name: "dg-ai-browser-batch" }));
			put(join(dgDir, name, "background.js"), "x");
		}

		const removed = removeLegacyExtensions([dgDir]);

		expect(removed.sort()).toEqual(names.map((name) => join(dgDir, name)).sort());
		for (const name of names) expect(existsSync(join(dgDir, name))).toBe(false);
	});

	test("keeps a folder with a different, missing or unreadable manifest", () => {
		const dgDir = join(scratch(), ".dg");
		put(join(dgDir, names[0], "manifest.json"), JSON.stringify({ name: "dg-ai-browser-batch-2" }));
		put(join(dgDir, names[1], "notes.txt"), "no manifest");
		put(join(dgDir, names[2], "manifest.json"), "{not json");

		expect(removeLegacyExtensions([dgDir])).toEqual([]);
		for (const name of names) expect(existsSync(join(dgDir, name))).toBe(true);
	});

	test("never touches the current extension folders or other names", () => {
		const dgDir = join(scratch(), ".dg");
		put(join(dgDir, "dg-ai-extension-chrome/manifest.json"), JSON.stringify({ name: "dg-ai-browser-batch" }));
		put(join(dgDir, "other/manifest.json"), JSON.stringify({ name: "dg-ai-browser-batch" }));

		expect(removeLegacyExtensions([dgDir])).toEqual([]);
		expect(existsSync(join(dgDir, "dg-ai-extension-chrome"))).toBe(true);
		expect(existsSync(join(dgDir, "other"))).toBe(true);
	});

	test("does not follow a symlink named like a legacy folder", () => {
		const root = scratch();
		const dgDir = join(root, ".dg");
		put(join(root, "elsewhere/manifest.json"), JSON.stringify({ name: "dg-ai-browser-batch" }));
		mkdirSync(dgDir, { recursive: true });
		symlinkSync(join(root, "elsewhere"), join(dgDir, names[0]));

		expect(removeLegacyExtensions([dgDir])).toEqual([]);
		expect(existsSync(join(root, "elsewhere/manifest.json"))).toBe(true);
	});

	test("scans every given home and lists matches without removing them", () => {
		const root = scratch();
		const first = join(root, "win/.dg");
		const second = join(root, "linux/.dg");
		put(join(first, names[1], "manifest.json"), JSON.stringify({ name: "dg-ai-browser-batch" }));
		put(join(second, names[2], "manifest.json"), JSON.stringify({ name: "dg-ai-browser-batch" }));

		expect(legacyExtensionDirs([first, second]).sort()).toEqual(
			[join(first, names[1]), join(second, names[2])].sort(),
		);
		expect(existsSync(join(first, names[1]))).toBe(true);
	});

	test("tolerates a missing .dg directory", () => {
		expect(removeLegacyExtensions([join(scratch(), "absent")])).toEqual([]);
	});
});
