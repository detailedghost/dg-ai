import { readFileSync, statSync } from "node:fs";

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
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

/** Refuses a secrets file that other users can read on POSIX. */
export function loadEnvFile(path: string): Record<string, string> {
	const stats = statSync(path);
	if (!stats.isFile())
		throw new Error(`env file is not a regular file: ${path}`);
	if (
		process.platform !== "win32" &&
		(stats.mode & GROUP_AND_WORLD_BITS) !== 0
	) {
		throw new Error(
			`env file ${path} is readable by other users; run chmod 600 on it`,
		);
	}
	return parseEnvFile(readFileSync(path, "utf8"));
}
