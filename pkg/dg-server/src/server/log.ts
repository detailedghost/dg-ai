import {
	existsSync,
	mkdirSync,
	statSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DgPaths } from "@dg/common/node";

const MAX_LOG_BYTES = 5_000_000;

/**
 * Size-capped log. Callers must never pass raw frame JSON or a token —
 * only structured, pre-redacted messages (validator/authorizer failure
 * messages never echo token values, only field paths and sessionIds).
 */
export type Logger = {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
	/** Status-report seam: the most recent error(), or null if none yet this run. */
	getLastError(): string | null;
};

export function createLogger(paths: DgPaths): Logger {
	mkdirSync(dirname(paths.logPath), { recursive: true, mode: 0o700 });
	if (!existsSync(paths.logPath)) writeFileSync(paths.logPath, "");

	let lastError: string | null = null;

	function write(level: string, message: string): void {
		try {
			if (statSync(paths.logPath).size > MAX_LOG_BYTES) {
				truncateSync(paths.logPath, 0);
			}
		} catch {
			// Log file vanished under us — recreate it on the next append.
		}
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
