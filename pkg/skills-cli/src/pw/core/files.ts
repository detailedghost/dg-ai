import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "@dg/common/node";

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export type FilePayload = { name: string; mimeType: string; buffer: Buffer };

export const inputPath = (cwd: string, file: string): string =>
	path.resolve(cwd, file);

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
	writeFileAtomic(file, data, 0o600);
	restrictFile(file);
}

/** A 0700 staging dir beside the target, holding a file with the target's name. */
export function stagingPathFor(file: string): string {
	return path.join(
		mkdtempSync(path.join(path.dirname(file), ".pw-")),
		path.basename(file),
	);
}

/** Sets 0600 on a staged file, renames it over the target, and removes its staging dir. */
export function publishStaged(staging: string, file: string): void {
	try {
		restrictFile(staging);
		renameSync(staging, file);
	} finally {
		rmSync(path.dirname(staging), { recursive: true, force: true });
	}
}

/** Produces into a 0700 staging dir beside the target, then renames the 0600 result over it. */
export async function publishPrivate(
	file: string,
	produce: (staging: string) => Promise<unknown>,
): Promise<void> {
	const staging = stagingPathFor(file);
	try {
		await produce(staging);
	} catch (error) {
		rmSync(path.dirname(staging), { recursive: true, force: true });
		throw error;
	}
	publishStaged(staging, file);
}

export function ensurePrivateDir(dir: string): void {
	const firstCreated = mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (firstCreated === undefined) return;
	for (let current = dir; ; current = path.dirname(current)) {
		chmodSync(current, 0o700);
		if (current === firstCreated) return;
	}
}

export async function buildFilePayloads(
	files: readonly string[],
	cwd: string,
): Promise<FilePayload[]> {
	const payloads: FilePayload[] = [];
	for (const file of files) {
		const resolved = inputPath(cwd, file);
		let size: number;
		try {
			const stat = statSync(resolved);
			if (!stat.isFile()) throw new Error(`Not a file: ${resolved}`);
			size = stat.size;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				throw new Error(`File not found: ${resolved}`);
			throw error;
		}
		if (size > MAX_UPLOAD_BYTES)
			throw new Error(`File ${resolved} is larger than 50 MB`);
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
