import {
	createHash,
	randomBytes,
	randomInt,
	randomUUID,
	timingSafeEqual,
} from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	type DgPaths,
	ensurePrivateDir,
	writeFileAtomic,
} from "@dg/common/node";

export const PAIRING_TTL_MS = 5 * 60 * 1_000;
export const PAIRING_MAX_ATTEMPTS = 5;

const PAIRING_LOCK_TIMEOUT_MS = 5_000;
const PAIRING_LOCK_RETRY_MS = 10;
const pairingLockWaiter = new Int32Array(new SharedArrayBuffer(4));

export type PairingRecord = {
	hash: string;
	salt: string;
	expiresAt: number;
	attemptsLeft: number;
};

export type PairingAttempt =
	| { outcome: "missing" }
	| { outcome: "expired" }
	| { outcome: "incorrect"; attemptsLeft: number }
	| { outcome: "accepted" };

function hashPairingCode(salt: string, code: string): string {
	return createHash("sha256").update(`${salt}${code}`).digest("hex");
}

function isPairingRecord(value: unknown): value is PairingRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const record = value as Record<string, unknown>;
	return (
		typeof record.hash === "string" &&
		/^[a-f0-9]{64}$/.test(record.hash) &&
		typeof record.salt === "string" &&
		record.salt.length > 0 &&
		typeof record.expiresAt === "number" &&
		Number.isFinite(record.expiresAt) &&
		typeof record.attemptsLeft === "number" &&
		Number.isInteger(record.attemptsLeft) &&
		record.attemptsLeft > 0 &&
		record.attemptsLeft <= PAIRING_MAX_ATTEMPTS
	);
}

function writePairingRecord(paths: DgPaths, record: PairingRecord): void {
	writeFileAtomic(paths.pairingPath, JSON.stringify(record), 0o600);
}

function deletePairingRecord(paths: DgPaths): void {
	rmSync(paths.pairingPath, { force: true });
}

function readPairingRecord(paths: DgPaths): PairingRecord | undefined {
	if (!existsSync(paths.pairingPath)) return undefined;
	try {
		const value: unknown = JSON.parse(readFileSync(paths.pairingPath, "utf8"));
		if (isPairingRecord(value)) return value;
	} catch {}
	deletePairingRecord(paths);
	return undefined;
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) {
		return undefined;
	}
	return typeof error.code === "string" ? error.code : undefined;
}

function lockOwnerIsAlive(lockPath: string): boolean | undefined {
	try {
		const pid = Number(readFileSync(join(lockPath, "owner"), "utf8"));
		if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			return errorCode(error) === "ESRCH" ? false : true;
		}
	} catch {
		return undefined;
	}
}

function clearStaleLock(lockPath: string, clearOwnerless: boolean): boolean {
	const ownerAlive = lockOwnerIsAlive(lockPath);
	if (ownerAlive !== false && !(clearOwnerless && ownerAlive === undefined)) {
		return false;
	}
	const stalePath = `${lockPath}.${process.pid}.${randomUUID()}.stale`;
	try {
		renameSync(lockPath, stalePath);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return true;
		throw error;
	}
	rmSync(stalePath, { force: true, recursive: true });
	return true;
}

function acquirePairingLock(paths: DgPaths): () => void {
	ensurePrivateDir(paths.stateDir);
	const lockPath = `${paths.pairingPath}.lock`;
	const deadline = Date.now() + PAIRING_LOCK_TIMEOUT_MS;
	while (true) {
		try {
			mkdirSync(lockPath, { mode: 0o700 });
			try {
				writeFileSync(join(lockPath, "owner"), String(process.pid), {
					mode: 0o600,
				});
			} catch (error) {
				rmSync(lockPath, { force: true, recursive: true });
				throw error;
			}
			return () => rmSync(lockPath, { force: true, recursive: true });
		} catch (error) {
			if (errorCode(error) !== "EEXIST") throw error;
			const timedOut = Date.now() >= deadline;
			if (clearStaleLock(lockPath, timedOut)) continue;
			if (timedOut) throw new Error("timed out waiting for the pairing lock");
			Atomics.wait(pairingLockWaiter, 0, 0, PAIRING_LOCK_RETRY_MS);
		}
	}
}

function withPairingLock<T>(paths: DgPaths, operation: () => T): T {
	const release = acquirePairingLock(paths);
	try {
		return operation();
	} finally {
		release();
	}
}

export function createPairingCode(
	paths: DgPaths,
	now = Date.now(),
): { code: string; expiresAt: number } {
	return withPairingLock(paths, () => {
		const code = randomInt(1_000_000).toString().padStart(6, "0");
		const salt = randomBytes(16).toString("base64url");
		const expiresAt = now + PAIRING_TTL_MS;
		writePairingRecord(paths, {
			hash: hashPairingCode(salt, code),
			salt,
			expiresAt,
			attemptsLeft: PAIRING_MAX_ATTEMPTS,
		});
		return { code, expiresAt };
	});
}

export function consumePairingAttempt(
	paths: DgPaths,
	code: string,
	now = Date.now(),
): PairingAttempt {
	return withPairingLock(paths, () => {
		const record = readPairingRecord(paths);
		if (!record) return { outcome: "missing" };
		if (record.expiresAt <= now) {
			deletePairingRecord(paths);
			return { outcome: "expired" };
		}
		const actualHash = hashPairingCode(record.salt, code);
		const expected = Buffer.from(record.hash, "hex");
		const actual = Buffer.from(actualHash, "hex");
		const matches = timingSafeEqual(expected, actual);
		if (matches) {
			deletePairingRecord(paths);
			return { outcome: "accepted" };
		}
		const attemptsLeft = record.attemptsLeft - 1;
		if (attemptsLeft === 0) {
			deletePairingRecord(paths);
		} else {
			writePairingRecord(paths, { ...record, attemptsLeft });
		}
		return { outcome: "incorrect", attemptsLeft };
	});
}
