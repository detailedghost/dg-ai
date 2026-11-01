import { chmodSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export type FilePayload = { name: string; mimeType: string; buffer: Buffer };

export const inputPath = (cwd: string, file: string): string => path.resolve(cwd, file);

export async function readInput(cwd: string, file: string): Promise<string> {
	const resolved = inputPath(cwd, file);
	const handle = Bun.file(resolved);
	if (!(await handle.exists())) throw new Error(`File not found: ${resolved}`);
	return handle.text();
}

export function restrictFile(file: string): void {
	chmodSync(file, 0o600);
}

export function writePrivate(file: string, data: string): void {
	writeFileSync(file, data, { mode: 0o600 });
	restrictFile(file);
}

export function ensurePrivateDir(dir: string): void {
	const firstCreated = mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (firstCreated === undefined) return;
	for (let current = dir; ; current = path.dirname(current)) {
		chmodSync(current, 0o700);
		if (current === firstCreated) return;
	}
}

export async function buildFilePayloads(files: readonly string[], cwd: string): Promise<FilePayload[]> {
	const payloads: FilePayload[] = [];
	for (const file of files) {
		const resolved = inputPath(cwd, file);
		let size: number;
		try {
			const stat = statSync(resolved);
			if (!stat.isFile()) throw new Error(`Not a file: ${resolved}`);
			size = stat.size;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`File not found: ${resolved}`);
			throw error;
		}
		if (size > MAX_UPLOAD_BYTES) throw new Error(`File ${resolved} is larger than 50 MB`);
		const handle = Bun.file(resolved);
		const mimeType = handle.type.split(";")[0] || "application/octet-stream";
		payloads.push({
			name: path.basename(resolved),
			mimeType,
			buffer: Buffer.from(await handle.arrayBuffer()),
		});
	}
	return payloads;
}
