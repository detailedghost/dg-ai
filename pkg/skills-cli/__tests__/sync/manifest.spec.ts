import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneStale, readManifest, writeManifest } from "../../src/sync/manifest";

const tmpDirs: string[] = [];

afterEach(() => {
	for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function withTmp(): string {
	const d = mkdtempSync(join(tmpdir(), "manifest-test-"));
	tmpDirs.push(d);
	return d;
}

describe("readManifest / writeManifest", () => {
	test("a missing manifest reads as an empty list", () => {
		expect(readManifest(join(withTmp(), "missing"))).toEqual([]);
	});

	test("round-trips a list of names", () => {
		const dir = withTmp();
		const manifest = join(dir, ".manifest");
		writeManifest(manifest, ["a", "b", "c"]);
		expect(readManifest(manifest)).toEqual(["a", "b", "c"]);
	});

	test("filters blank lines and traversal-looking entries", () => {
		const dir = withTmp();
		const manifest = join(dir, ".manifest");
		writeFileSync(manifest, "a\n\n..\n.\n/abs\nb\n");
		expect(readManifest(manifest)).toEqual(["a", "b"]);
	});
});

describe("pruneStale", () => {
	test("removes a directory no longer in keep and rewrites the manifest", () => {
		const dir = withTmp();
		const manifest = join(dir, ".manifest");
		mkdirSync(join(dir, "a"));
		mkdirSync(join(dir, "b"));
		writeManifest(manifest, ["a", "b"]);

		const result = pruneStale(dir, "", manifest, ["b"]);

		expect(result.pruned).toEqual(["a"]);
		expect(existsSync(join(dir, "a"))).toBe(false);
		expect(existsSync(join(dir, "b"))).toBe(true);
		expect(readManifest(manifest)).toEqual(["b"]);
	});

	test("never removes an entry the manifest never listed", () => {
		const dir = withTmp();
		const manifest = join(dir, ".manifest");
		mkdirSync(join(dir, "never-managed"));
		writeManifest(manifest, []);

		const result = pruneStale(dir, "", manifest, []);

		expect(result.pruned).toEqual([]);
		expect(existsSync(join(dir, "never-managed"))).toBe(true);
	});

	test("supports a file suffix for non-directory names", () => {
		const dir = withTmp();
		const manifest = join(dir, ".manifest");
		writeFileSync(join(dir, "stale.agent.md"), "x");
		writeFileSync(join(dir, "fresh.agent.md"), "x");
		writeManifest(manifest, ["stale", "fresh"]);

		const result = pruneStale(dir, ".agent.md", manifest, ["fresh"]);

		expect(result.pruned).toEqual(["stale"]);
		expect(existsSync(join(dir, "stale.agent.md"))).toBe(false);
		expect(existsSync(join(dir, "fresh.agent.md"))).toBe(true);
	});

	test("an empty manifest on first run keeps everything and just records the new set", () => {
		const dir = withTmp();
		const manifest = join(dir, ".manifest");
		mkdirSync(join(dir, "first"));

		const result = pruneStale(dir, "", manifest, ["first"]);

		expect(result.pruned).toEqual([]);
		expect(readManifest(manifest)).toEqual(["first"]);
	});
});
