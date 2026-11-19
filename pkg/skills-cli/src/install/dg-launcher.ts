import { closeSync, lstatSync, openSync, readSync, statSync } from "node:fs";
import { isMissingPath } from "@dg/common";

const SNIFF_BYTES = 4096;
const markerOf = (platform: NodeJS.Platform): string => (platform === "win32" ? "lib\\current\\dg.js" : "lib/current/dg.js");

/** True for a regular file, or a link that ends in one, whose first bytes are text that runs the current dg bundle. */
export function isDgLauncher(path: string, platform: NodeJS.Platform = process.platform): boolean {
	try {
		const kind = lstatSync(path).isSymbolicLink() ? statSync(path) : lstatSync(path);
		if (!kind.isFile()) return false;
		const fd = openSync(path, "r");
		try {
			const buffer = Buffer.alloc(SNIFF_BYTES);
			const head = buffer.subarray(0, readSync(fd, buffer, 0, SNIFF_BYTES, 0));
			return !head.includes(0) && head.includes(markerOf(platform));
		} finally {
			closeSync(fd);
		}
	} catch {
		return false;
	}
}

/** True when `path` exists, is not a link with no target, and is not a dg launcher. */
export function holdsOtherFile(path: string, platform: NodeJS.Platform): boolean {
	try {
		lstatSync(path);
	} catch {
		return false;
	}
	try {
		statSync(path);
	} catch (error) {
		if (isMissingPath(error)) return false;
	}
	return !isDgLauncher(path, platform);
}
