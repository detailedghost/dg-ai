import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "@dg/common/node";
import { type PickedBundle, UA, verifyReleaseAsset } from "../utils/lib";
import { linkCurrent, readCurrent } from "./current";

const VERSION_DIR = /^\d+\.\d+\.\d+/;

function selfCheck(runtimeBin: string, entry: string, version: string): void {
	const result = spawnSync(runtimeBin, [entry, "dg-skills", "--version"], { encoding: "utf8", timeout: 30_000 });
	if (result.error) throw new Error(`bundle self-check could not start: ${result.error.message}`);
	if (result.status !== 0) {
		const detail = result.stderr.trim().split("\n").at(-1) || `exit ${result.status}`;
		throw new Error(`bundle self-check failed: ${detail}`);
	}
	const printed = result.stdout.trim();
	if (printed.split(/\s+/)[0] !== version) {
		throw new Error(`bundle self-check failed: expected ${version}, printed ${printed || "nothing"}`);
	}
}

function pruneLib(lib: string, keep: ReadonlySet<string>): void {
	try {
		for (const name of readdirSync(lib)) {
			if (VERSION_DIR.test(name) && !keep.has(name)) rmSync(join(lib, name), { recursive: true, force: true });
		}
	} catch (err) {
		console.warn(`⚠ could not remove old dg bundles: ${err instanceof Error ? err.message : err}`);
	}
}

/**
 * Installs the verified dg-lib bundle under `<root>/lib/<version>` and links `lib/current` to it.
 * It keeps the version it replaces for rollback and removes older ones. An installed version
 * is only relinked, with no download. A failed check leaves `lib/current` and the lib dir as they were.
 * `beforeActivate` runs once the bundle passed its check, just before `lib/current` switches;
 * the function it returns runs if that switch fails.
 */
export async function fetchBundle(
	root: string,
	release: PickedBundle,
	runtimeBin: string,
	beforeActivate?: () => (() => void) | void,
): Promise<string> {
	const lib = join(root, "lib");
	const final = join(lib, release.version);
	if (!existsSync(join(final, "dg.js"))) {
		const res = await fetch(release.url, { headers: UA });
		if (!res.ok) throw new Error(`${release.assetName} download failed: HTTP ${res.status}`);
		const tarball = new Uint8Array(await res.arrayBuffer());
		await verifyReleaseAsset(release.sumsUrl, release.assetName, tarball, `v${release.version}`);
		mkdirSync(lib, { recursive: true });
		const staging = mkdtempSync(join(lib, `install-${release.version}-`));
		const scratch = mkdtempSync(join(tmpdir(), "dg-bundle-"));
		try {
			const archive = join(scratch, release.assetName);
			writeFileSync(archive, tarball);
			run("tar", ["-xzf", archive, "-C", staging]);
			selfCheck(runtimeBin, join(staging, "dg.js"), release.version);
			if (!existsSync(join(final, "dg.js"))) {
				rmSync(final, { recursive: true, force: true });
				renameSync(staging, final);
			}
		} finally {
			rmSync(staging, { recursive: true, force: true });
			rmSync(scratch, { recursive: true, force: true });
		}
	}
	const undo = beforeActivate?.();
	const replaced = readCurrent(root, "lib");
	try {
		linkCurrent(root, "lib", release.version);
	} catch (err) {
		undo?.();
		throw err;
	}
	pruneLib(lib, new Set([release.version, ...(replaced ? [replaced] : [])]));
	return final;
}
