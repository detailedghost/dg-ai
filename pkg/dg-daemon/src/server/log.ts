import {
	existsSync,
	readdirSync,
	rmSync,
	statSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { type DgPaths, ensurePrivateDir } from "@dg/common/node";

const MAX_LOG_BYTES = 5_000_000;
const MS_PER_DAY = 86_400_000;
const DATED_LOG_NAME = /^daemon-(\d{4}-\d{2}-\d{2})\.log$/;

export const LOG_RETENTION_DAYS = 7;

export type Logger = {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
	getLastError(): string | null;
};

export type LoggerSeams = {
	now?: () => Date;
};

function dayStamp(at: Date): string {
	return at.toISOString().slice(0, 10);
}

export function logFileFor(logDir: string, at: Date): string {
	return join(logDir, `daemon-${dayStamp(at)}.log`);
}

/** Deletes dated log files older than the retention window; returns the names it removed. */
export function pruneLogs(logDir: string, now: Date): string[] {
	const oldestKept = dayStamp(
		new Date(now.getTime() - (LOG_RETENTION_DAYS - 1) * MS_PER_DAY),
	);
	const expired = readdirSync(logDir)
		.map((name) => ({ name, stamp: DATED_LOG_NAME.exec(name)?.[1] }))
		.filter(
			(entry): entry is { name: string; stamp: string } =>
				entry.stamp !== undefined && entry.stamp < oldestKept,
		)
		.map((entry) => entry.name);

	for (const name of expired) rmSync(join(logDir, name), { force: true });
	return expired;
}

export function createLogger(paths: DgPaths, seams: LoggerSeams = {}): Logger {
	const now = seams.now ?? (() => new Date());
	ensurePrivateDir(paths.logDir);

	let openStamp = "";
	let openFile = "";
	let lastError: string | null = null;

	function fileFor(at: Date): string {
		const stamp = dayStamp(at);
		if (stamp === openStamp) return openFile;
		openStamp = stamp;
		openFile = logFileFor(paths.logDir, at);
		if (!existsSync(openFile)) writeFileSync(openFile, "", { mode: 0o600 });
		pruneLogs(paths.logDir, at);
		return openFile;
	}

	function write(level: string, message: string): void {
		const at = now();
		const file = fileFor(at);
		try {
			if (statSync(file).size > MAX_LOG_BYTES) truncateSync(file, 0);
		} catch {}
		void appendFile(file, `${at.toISOString()} [${level}] ${message}\n`).catch(
			() => {},
		);
	}

	fileFor(now());

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
