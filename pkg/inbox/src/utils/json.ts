import { mkdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export async function readJsonFile<T>(path: string): Promise<T> {
	const file = Bun.file(path);
	if (!(await file.exists())) {
		throw new Error(`Required file not found: ${path}`);
	}
	return file.json() as Promise<T>;
}

export async function readJsonFileIfExists<T>(
	path: string,
): Promise<T | undefined> {
	const file = Bun.file(path);
	if (!(await file.exists())) {
		return undefined;
	}
	return file.json() as Promise<T>;
}

// Replace the destination only after the document is complete. An in-place
// write truncates first, and a concurrent reader then fails to parse JSON.
export async function writeJsonFile(
	path: string,
	value: unknown,
): Promise<void> {
	const directory = dirname(path);
	await mkdir(directory, { recursive: true });
	const temporary = join(
		directory,
		`.${basename(path)}.${crypto.randomUUID()}.tmp`,
	);
	try {
		await Bun.write(temporary, stringifyJson(value));
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}

export function stringifyJson(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}
