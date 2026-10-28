import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { VerifyPaths } from "./board";
import { parseManifest, type VerifyManifest } from "./manifest";

export function saveManifest(paths: VerifyPaths, manifest: VerifyManifest): void {
	mkdirSync(paths.dir, { recursive: true });
	writeFileSync(paths.manifest, `${JSON.stringify(manifest)}\n`);
}

export function loadManifest(paths: VerifyPaths): VerifyManifest {
	let text: string;
	try {
		text = readFileSync(paths.manifest, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			throw new Error(`no capture manifest at ${paths.manifest}; pass --manifest=<file>`);
		throw error;
	}
	return parseManifest(JSON.parse(text));
}
