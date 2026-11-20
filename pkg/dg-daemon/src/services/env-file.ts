import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";

export const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const GROUP_AND_WORLD_BITS = 0o077;

function unquote(value: string): string {
	const quote = value[0];
	const quoted =
		value.length >= 2 &&
		(quote === '"' || quote === "'") &&
		value.endsWith(quote);
	return quoted ? value.slice(1, -1) : value;
}

/** Parses KEY=VALUE lines; blank lines and lines starting with # are skipped. */
export function parseEnvFile(text: string): Record<string, string> {
	return Object.fromEntries(
		text
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.length > 0 && !line.startsWith("#"))
			.map((line, index) => {
				const eq = line.indexOf("=");
				const key = eq < 0 ? "" : line.slice(0, eq).trim();
				if (!ENV_KEY.test(key)) {
					throw new Error(`env file entry ${index + 1} is not KEY=VALUE`);
				}
				return [key, unquote(line.slice(eq + 1).trim())];
			}),
	);
}

/** Refuses an open file that is not regular or that other users can read on POSIX. */
export function assertPrivateOpenFile(fd: number, path: string, noun: string): void {
	const stats = fstatSync(fd);
	if (!stats.isFile()) throw new Error(`${noun} is not a regular file: ${path}`);
	if (process.platform !== "win32" && (stats.mode & GROUP_AND_WORLD_BITS) !== 0) {
		throw new Error(`${noun} ${path} is readable by other users; run chmod 600 on it`);
	}
}

export function loadEnvFile(path: string): Record<string, string> {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		assertPrivateOpenFile(fd, path, "env file");
		return parseEnvFile(readFileSync(fd, "utf8"));
	} finally {
		closeSync(fd);
	}
}
