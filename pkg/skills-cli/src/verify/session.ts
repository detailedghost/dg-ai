import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseManifest, type VerifyManifest } from "./manifest";
import { ensureSession, writeReload, type VerifyPaths } from "./verdict";

export function saveManifest(paths: VerifyPaths, manifest: VerifyManifest): void {
	ensureSession(paths);
	writeFileSync(paths.manifest, `${JSON.stringify(manifest)}\n`);
}

export function loadManifest(paths: VerifyPaths): VerifyManifest {
	let text: string;
	try {
		text = readFileSync(paths.manifest, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			throw new Error(`no verify session at ${paths.dir}`);
		throw error;
	}
	return parseManifest(JSON.parse(text));
}

/** Clear picks and shots so start begins a new review in the same directory. */
export function resetSession(paths: VerifyPaths): void {
	rmSync(paths.decisions, { force: true });
	rmSync(paths.verdict, { force: true });
	rmSync(paths.claimed, { force: true });
	rmSync(paths.notifyDir, { recursive: true, force: true });
	rmSync(paths.shotsDir, { recursive: true, force: true });
	rmSync(paths.tests, { force: true });
	rmSync(join(paths.dir, "reports"), { recursive: true, force: true });
	ensureSession(paths);
	writeReload(paths, 1);
}
