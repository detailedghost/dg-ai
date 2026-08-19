/**
 * resolveAssetFilePath: defense-in-depth path containment, layering
 * proto.ts's ensureSafeAnswerPaths pattern (per-component lstat symlink
 * rejection PLUS a final realpath containment check) rather than a
 * from-scratch check (Engineering bullet, explicit).
 *
 * [SPEC] ASSUMED module surface (`resolveAssetFilePath(sessionDir, storedName)`,
 * throwing `AssetPathUnsafeError`) — plan.md pins the CHECK, not the function
 * shape; see deferrals.
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	AssetPathUnsafeError,
	resolveAssetFilePath,
} from "../../src/assets/safe-path";

function freshDir(): string {
	return mkdtempSync(join(tmpdir(), "dg-asset-safe-path-"));
}

describe("resolveAssetFilePath", () => {
	it("resolves a legitimate file that lives directly under the session directory", () => {
		const sessionDir = freshDir();
		writeFileSync(join(sessionDir, "asset-1"), "hello");

		const resolved = resolveAssetFilePath(sessionDir, "asset-1");

		expect(resolved).toBe(resolve(join(sessionDir, "asset-1")));
	});

	it("refuses a stored name that is itself a symlink out of the session directory", () => {
		const sessionDir = freshDir();
		const outsideDir = freshDir();
		const secretPath = join(outsideDir, "secret");
		writeFileSync(secretPath, "outside contents");
		symlinkSync(secretPath, join(sessionDir, "asset-1"));

		expect(() => resolveAssetFilePath(sessionDir, "asset-1")).toThrow(
			AssetPathUnsafeError,
		);
	});

	it("refuses a stored name embedding a traversal segment, even though the id/filename is server-controlled", () => {
		const sessionDir = freshDir();
		expect(() => resolveAssetFilePath(sessionDir, "../escape")).toThrow(
			AssetPathUnsafeError,
		);
		expect(() =>
			resolveAssetFilePath(sessionDir, "nested/../../escape"),
		).toThrow(AssetPathUnsafeError);
	});

	it("refuses when the session directory itself resolves through a symlink out of its parent", () => {
		const assetsRoot = freshDir();
		const outsideRoot = freshDir();
		const realSessionDir = join(outsideRoot, "session-real");
		mkdirSync(realSessionDir);
		writeFileSync(join(realSessionDir, "asset-1"), "hello");
		const linkedSessionDir = join(assetsRoot, "session-a");
		symlinkSync(realSessionDir, linkedSessionDir);

		expect(() => resolveAssetFilePath(linkedSessionDir, "asset-1")).toThrow(
			AssetPathUnsafeError,
		);
	});

	it("throws rather than silently returning a made-up path for a file that was never staged", () => {
		const sessionDir = freshDir();
		expect(() => resolveAssetFilePath(sessionDir, "never-staged")).toThrow();
	});
});
