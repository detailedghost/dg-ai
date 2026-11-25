import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "../utils/lib";

export const PATCH_WINDOW_LOG = 27;

export class PatchMismatch extends Error {
	override name = "PatchMismatch";
}

/** `dg-<key>-from-<version>.zpatch` for a compiled asset name, with any `.exe`, `.zst` or `.gz` suffix dropped. */
export const patchAssetName = (assetName: string, fromVersion: string): string =>
	`${assetName.replace(/\.(zst|gz)$/, "").replace(/\.exe$/, "")}-from-${fromVersion}.zpatch`;

/** Applies a `zstd --patch-from` patch to `oldBytes`; returns bytes only when their sha256 is `expectedSha256`. */
export function applyPatch(
	oldBytes: Uint8Array,
	patchBytes: Uint8Array,
	expectedSha256: string,
	zstd: string | null = Bun.which("zstd"),
): Uint8Array {
	if (!zstd) throw new PatchMismatch("zstd is not on PATH, so the patch cannot be applied");
	const dir = mkdtempSync(join(tmpdir(), "dg-patch-"));
	try {
		const [oldFile, patchFile, outFile] = ["old", "patch", "out"].map((name) => join(dir, name));
		writeFileSync(oldFile, oldBytes);
		writeFileSync(patchFile, patchBytes);
		const run = spawnSync(
			zstd,
			["-d", "-q", "--force", `--long=${PATCH_WINDOW_LOG}`, `--patch-from=${oldFile}`, patchFile, "-o", outFile],
			{ encoding: "utf8", timeout: 120_000 },
		);
		if (run.error) throw new PatchMismatch(`zstd could not start: ${run.error.message}`);
		if (run.status !== 0) throw new PatchMismatch(`zstd could not apply the patch: ${run.stderr.trim().split("\n").at(-1) || `exit ${run.status}`}`);
		const patched = new Uint8Array(readFileSync(outFile));
		if (sha256Hex(patched) !== expectedSha256.toLowerCase()) throw new PatchMismatch("the patched program does not match its sha256");
		return patched;
	} catch (err) {
		if (err instanceof PatchMismatch) throw err;
		throw new PatchMismatch(`the patch could not be applied: ${err instanceof Error ? err.message : err}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
