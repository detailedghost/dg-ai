import { dirname } from "node:path";

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

export async function writeJsonFile(
	path: string,
	value: unknown,
): Promise<void> {
	await Bun.$`mkdir -p ${dirname(path)}`.quiet();
	await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function stringifyJson(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}
