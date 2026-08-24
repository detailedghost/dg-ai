import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import type { DgPaths } from "@dg/common/node";
import { ensurePrivateDir } from "../utils/fs";

export function mintToken(): string {
	return randomBytes(32).toString("base64url");
}

export function tokensEqual(a: string, b: string): boolean {
	const bufA = Buffer.from(a, "utf8");
	const bufB = Buffer.from(b, "utf8");
	if (bufA.length !== bufB.length) {
		const maxLen = Math.max(bufA.length, bufB.length, 1);
		timingSafeEqual(
			Buffer.concat([bufA, Buffer.alloc(maxLen - bufA.length)]),
			Buffer.concat([bufB, Buffer.alloc(maxLen - bufB.length)]),
		);
		return false;
	}
	return timingSafeEqual(bufA, bufB);
}

function sessionFilePath(paths: DgPaths, sessionId: string): string {
	return `${paths.sessionsDir}/${sessionId}.json`;
}

export type SessionTokenRecord = {
	sessionId: string;
	token: string;
	cwd: string;
	agentIdentity: string;
};

export function writeSessionToken(
	paths: DgPaths,
	sessionId: string,
	record: SessionTokenRecord,
): void {
	ensurePrivateDir(paths.sessionsDir);
	const file = sessionFilePath(paths, sessionId);
	writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
}

export function removeSessionToken(paths: DgPaths, sessionId: string): void {
	rmSync(sessionFilePath(paths, sessionId), { force: true });
}

export function readSessionToken(paths: DgPaths, sessionId: string): string {
	const override = process.env.DG_SESSION_TOKEN;
	if (override !== undefined) return override;
	const raw = readFileSync(sessionFilePath(paths, sessionId), "utf8");
	return (JSON.parse(raw) as { token: string }).token;
}
