import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";

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
