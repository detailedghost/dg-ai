import {
	createHash,
	randomBytes,
	randomInt,
	timingSafeEqual,
} from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import {
	type DgPaths,
	ensurePrivateDir,
	writeFileAtomic,
} from "@dg/common/node";

export const PAIRING_TTL_MS = 5 * 60 * 1_000;
export const PAIRING_MAX_ATTEMPTS = 5;

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
	ensurePrivateDir(paths.stateDir);
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

export function createPairingCode(
	paths: DgPaths,
	now = Date.now(),
): { code: string; expiresAt: number } {
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
}

export function consumePairingAttempt(
	paths: DgPaths,
	code: string,
	now = Date.now(),
): PairingAttempt {
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
}
