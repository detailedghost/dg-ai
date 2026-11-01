import { randomUUID } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	truncateSync,
	writeFileSync,
} from "node:fs";

export function ensurePrivateDir(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	chmodSync(path, 0o700);
}

export function writeFileAtomic(
	path: string,
	data: string | Buffer,
	mode?: number,
	rename: typeof renameSync = renameSync,
): void {
	const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(tmp, data, mode === undefined ? undefined : { mode });
		if (mode !== undefined) chmodSync(tmp, mode);
		rename(tmp, path);
	} catch (error) {
		rmSync(tmp, { force: true });
		throw error;
	}
}

/** The file a write should replace: the target of a symlink, the path itself when absent; a dangling link throws. */
export function writeTarget(path: string): string {
	try {
		return realpathSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	let link = false;
	try {
		link = lstatSync(path).isSymbolicLink();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (link)
		throw new Error(
			`${path} is a symlink to a missing file; fix the link and run the command again`,
		);
	return path;
}

/** Atomically replaces a file through its symlink, keeping the existing mode or using newMode for a new file. */
export function writeFilePreserving(
	path: string,
	data: string | Buffer,
	newMode: number,
): void {
	const target = writeTarget(path);
	const mode = existsSync(target) ? statSync(target).mode & 0o777 : newMode;
	writeFileAtomic(target, data, mode);
}

/** Copy-truncates so a writer holding the file open in append mode keeps logging to the same path. */
export function rotateLogIfLarge(logFile: string, maxBytes: number): void {
	if (!existsSync(logFile) || statSync(logFile).size <= maxBytes) return;
	copyFileSync(logFile, `${logFile}.1`);
	truncateSync(logFile, 0);
}
