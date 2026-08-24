import { existsSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DgPaths } from "@dg/common/node";
import { ensurePrivateDir } from "../utils/fs";

const MAX_LOG_BYTES = 5_000_000;

export type Logger = {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
	getLastError(): string | null;
};

export function createLogger(paths: DgPaths): Logger {
	ensurePrivateDir(dirname(paths.logPath));
	if (!existsSync(paths.logPath)) writeFileSync(paths.logPath, "");

	let lastError: string | null = null;

	function write(level: string, message: string): void {
		try {
			if (statSync(paths.logPath).size > MAX_LOG_BYTES) {
				truncateSync(paths.logPath, 0);
			}
		} catch {}
		const line = `${new Date().toISOString()} [${level}] ${message}\n`;
		void appendFile(paths.logPath, line).catch(() => {});
	}

	return {
		info: (message) => write("info", message),
		warn: (message) => write("warn", message),
		error: (message) => {
			lastError = message;
			write("error", message);
		},
		getLastError: () => lastError,
	};
}
