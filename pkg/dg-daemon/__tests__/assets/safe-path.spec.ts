import { describe, expect, it } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	AssetMissingError,
	AssetPathUnsafeError,
	assertFlatSegment,
	openAssetFile,
	resolveAssetFilePath,
} from "../../src/assets/safe-path";
import { freshTempDir } from "../utils/daemon-harness";

const SESSION = "session-a";

function freshDir(): string {
	return freshTempDir("dg-asset-safe-path");
}

function freshRootWithSession(): { root: string; sessionDir: string } {
	const root = freshDir();
	const sessionDir = join(root, SESSION);
	mkdirSync(sessionDir);
	return { root, sessionDir };
}

describe("assertFlatSegment", () => {
	it.each([
		["", "empty"],
		[".", "dot"],
		["..", "dot-dot"],
		["a/b", "separator"],
		["../escape", "traversal"],
		["a\\b", "backslash separator"],
		["/absolute", "absolute path"],
		["nul\0byte", "embedded NUL"],
	])("refuses %p (%s)", (name) => {
		expect(() => assertFlatSegment(name)).toThrow(AssetPathUnsafeError);
	});

	it("accepts the flat uuid-shaped segment registerAsset actually writes", () => {
		expect(() =>
			assertFlatSegment("1f0a7b6c-2d3e-4f50-8a9b-0c1d2e3f4a5b"),
		).not.toThrow();
	});
});

describe("resolveAssetFilePath", () => {
	it("resolves a legitimate file that lives directly under the session directory", () => {
		const { root, sessionDir } = freshRootWithSession();
		writeFileSync(join(sessionDir, "asset-1"), "hello");

		const resolved = resolveAssetFilePath(root, SESSION, "asset-1");

		expect(resolved).toBe(resolve(join(sessionDir, "asset-1")));
	});

	it("refuses a stored name that is itself a symlink out of the session directory", () => {
		const { root, sessionDir } = freshRootWithSession();
		const outsideDir = freshDir();
		const secretPath = join(outsideDir, "secret");
		writeFileSync(secretPath, "outside contents");
		symlinkSync(secretPath, join(sessionDir, "asset-1"));

		expect(() => resolveAssetFilePath(root, SESSION, "asset-1")).toThrow(
			AssetPathUnsafeError,
		);
	});

	it("refuses a stored name embedding a traversal segment, even though the id is server-controlled", () => {
		const { root } = freshRootWithSession();
		expect(() => resolveAssetFilePath(root, SESSION, "../escape")).toThrow(
			AssetPathUnsafeError,
		);
		expect(() =>
			resolveAssetFilePath(root, SESSION, "nested/../../escape"),
		).toThrow(AssetPathUnsafeError);
	});

	it("refuses a traversal segment in the SESSION id too, not only in the stored name", () => {
		const { root } = freshRootWithSession();
		expect(() => resolveAssetFilePath(root, "../elsewhere", "asset-1")).toThrow(
			AssetPathUnsafeError,
		);
	});

	it("refuses when the session directory itself is a symlink out of the assets root", () => {
		const root = freshDir();
		const outsideRoot = freshDir();
		const realSessionDir = join(outsideRoot, "session-real");
		mkdirSync(realSessionDir);
		writeFileSync(join(realSessionDir, "asset-1"), "hello");
		symlinkSync(realSessionDir, join(root, SESSION));

		expect(() => resolveAssetFilePath(root, SESSION, "asset-1")).toThrow(
			AssetPathUnsafeError,
		);
	});

	it("refuses a session directory symlinked to a SIBLING inside the same root, which realpath containment alone would allow", () => {
		const root = freshDir();
		const realSessionDir = join(root, "session-elsewhere");
		mkdirSync(realSessionDir);
		writeFileSync(join(realSessionDir, "asset-1"), "hello");
		symlinkSync(realSessionDir, join(root, SESSION));

		expect(() => resolveAssetFilePath(root, SESSION, "asset-1")).toThrow(
			AssetPathUnsafeError,
		);
	});

	it("refuses when the assets ROOT is a symlink — the hole a session-directory-only walk left open", () => {
		const parent = freshDir();
		const outsideRoot = freshDir();
		const realSessionDir = join(outsideRoot, SESSION);
		mkdirSync(realSessionDir);
		writeFileSync(join(realSessionDir, "asset-1"), "hello");
		const linkedRoot = join(parent, "dg-assets");
		symlinkSync(outsideRoot, linkedRoot);

		expect(() => resolveAssetFilePath(linkedRoot, SESSION, "asset-1")).toThrow(
			AssetPathUnsafeError,
		);
	});

	it("refuses a relative assets root outright rather than resolving it against cwd", () => {
		expect(() =>
			resolveAssetFilePath("relative/assets", SESSION, "asset-1"),
		).toThrow(AssetPathUnsafeError);
	});

	it("refuses a stored name that is a directory rather than a regular file", () => {
		const { root, sessionDir } = freshRootWithSession();
		mkdirSync(join(sessionDir, "asset-1"));

		expect(() => resolveAssetFilePath(root, SESSION, "asset-1")).toThrow(
			AssetPathUnsafeError,
		);
	});

	it("refuses a FIFO planted at the staged path — a synchronous open on one never returns", () => {
		const { root, sessionDir } = freshRootWithSession();
		const fifo = join(sessionDir, "asset-1");
		const made = Bun.spawnSync(["mkfifo", fifo]);
		expect(made.exitCode).toBe(0);

		expect(() => resolveAssetFilePath(root, SESSION, "asset-1")).toThrow(
			AssetPathUnsafeError,
		);
	});

	it("reports a never-staged name as MISSING, distinct from a containment refusal", () => {
		const { root } = freshRootWithSession();
		expect(() => resolveAssetFilePath(root, SESSION, "never-staged")).toThrow(
			AssetMissingError,
		);
	});
});

describe("openAssetFile", () => {
	it("resolves and opens in one step, handing back the staged bytes", async () => {
		const { root, sessionDir } = freshRootWithSession();
		writeFileSync(join(sessionDir, "asset-1"), "staged bytes");

		const handle = await openAssetFile(root, SESSION, "asset-1");
		try {
			const stats = await handle.stat();
			expect(stats.isFile()).toBe(true);
			expect(stats.size).toBe("staged bytes".length);
			expect((await handle.readFile()).toString("utf8")).toBe("staged bytes");
		} finally {
			await handle.close();
		}
	});

	it("refuses rather than opening through a symlink at the staged path", async () => {
		const { root, sessionDir } = freshRootWithSession();
		const outsideDir = freshDir();
		writeFileSync(join(outsideDir, "secret"), "outside contents");
		symlinkSync(join(outsideDir, "secret"), join(sessionDir, "asset-1"));

		await expect(openAssetFile(root, SESSION, "asset-1")).rejects.toThrow(
			AssetPathUnsafeError,
		);
	});
});
