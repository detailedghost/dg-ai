import { closeSync, existsSync, lstatSync, openSync, readdirSync, readlinkSync, readSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { isMissingPath } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node/dg-paths";

const SNIFF_BYTES = 4096;
const VERSION_DIR = /^\d+\.\d+\.\d+/;
const markerOf = (platform: NodeJS.Platform): string => (platform === "win32" ? "lib\\current\\dg.js" : "lib/current/dg.js");

function isBundleShim(path: string, platform: NodeJS.Platform): boolean {
	try {
		const stat = statSync(path);
		if (!stat.isFile()) return false;
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

function linksIntoRoot(path: string, root: string): boolean {
	try {
		if (!lstatSync(path).isSymbolicLink()) return false;
		const target = readlinkSync(path);
		const full = isAbsolute(target) ? target : resolve(path, "..", target);
		const bin = join(root, "bin");
		return full.startsWith(`${bin}/`) || full.startsWith(`${bin}\\`);
	} catch {
		return false;
	}
}

function hardLinkIntoRoot(path: string, root: string): boolean {
	try {
		const { ino, dev } = statSync(path);
		const bin = join(root, "bin");
		return readdirSync(bin).some((name) => {
			const installed = join(bin, name, "dg.exe");
			if (!VERSION_DIR.test(name) || !existsSync(installed)) return false;
			const other = statSync(installed);
			return other.ino === ino && other.dev === dev;
		});
	} catch {
		return false;
	}
}

/**
 * True for a launcher dg wrote: a link into `<root>/bin/`, a hard link to an installed `dg.exe`, or an old
 * shim whose first bytes are text that runs the `lib/current/dg.js` bundle.
 */
export function isDgLauncher(
	path: string,
	platform: NodeJS.Platform = process.platform,
	root: string = resolveDgPaths().dataDir,
): boolean {
	return linksIntoRoot(path, root) || hardLinkIntoRoot(path, root) || isBundleShim(path, platform);
}

/** True when `path` exists, is not a link with no target, and is not a dg launcher. */
export function holdsOtherFile(path: string, platform: NodeJS.Platform, root?: string): boolean {
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
	return !isDgLauncher(path, platform, root);
}
