import { randomUUID } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	renameSync,
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
): void {
	const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(tmp, data, mode === undefined ? undefined : { mode });
	renameSync(tmp, path);
}

/** Copy-truncates so a writer holding the file open in append mode keeps logging to the same path. */
export function rotateLogIfLarge(logFile: string, maxBytes: number): void {
	if (!existsSync(logFile) || statSync(logFile).size <= maxBytes) return;
	copyFileSync(logFile, `${logFile}.1`);
	truncateSync(logFile, 0);
}
