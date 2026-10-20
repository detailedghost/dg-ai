import {
	closeSync,
	fstatSync,
	mkdirSync,
	openSync,
	readFileSync,
} from "node:fs";
import { STALE_LOCK_MS, vizConfig } from "./config";
import { lockFilePath, lockRelease, lockTryAcquire } from "./respond-core";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_MS = 100;

function reapIfStale(path: string): void {
	try {
		const fd = openSync(path, "r");
		try {
			const stale = Date.now() - fstatSync(fd).mtimeMs > STALE_LOCK_MS;
			if (stale) lockRelease(path, readFileSync(fd, "utf-8"));
		} finally {
			closeSync(fd);
		}
	} catch {
		return;
	}
}

/** Per-slug lock built on the viewer's O_EXCL primitives so CLI and SSR endpoint agree. */
export async function withLock<T>(
	slug: string,
	fn: () => Promise<T> | T,
): Promise<T> {
	const timeoutMs = parseInt(
		process.env.LOCK_TIMEOUT_MS ?? String(DEFAULT_TIMEOUT_MS),
		10,
	);
	const retryMs = parseInt(
		process.env.LOCK_RETRY_MS ?? String(DEFAULT_RETRY_MS),
		10,
	);

	const dir = `${vizConfig().vizDir}/${slug}`;
	mkdirSync(dir, { recursive: true });
	const path = lockFilePath(dir);
	const deadline = Date.now() + timeoutMs;

	while (true) {
		reapIfStale(path);

		const token = lockTryAcquire(path);
		if (token !== null) {
			try {
				return await fn();
			} finally {
				lockRelease(path, token);
			}
		}

		if (Date.now() >= deadline) {
			throw new Error(`lock timeout for slug "${slug}" after ${timeoutMs}ms`);
		}

		await Bun.sleep(retryMs);
	}
}
