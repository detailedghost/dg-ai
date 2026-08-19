import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { DgPaths } from "@dg/common/node";

/** >=128 bits from a CSPRNG — 32 bytes (256 bits) for headroom. */
export function mintToken(): string {
	return randomBytes(32).toString("base64url");
}

export function tokensEqual(a: string, b: string): boolean {
	const bufA = Buffer.from(a, "utf8");
	const bufB = Buffer.from(b, "utf8");
	// timingSafeEqual throws on length mismatch — pad and compare anyway so a
	// mismatched length still burns constant time instead of an early exit.
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

/** ~/.dg/sessions/<id>.json, mode 0600 inside a 0700 dir. Never written to the lockfile. */
export function writeSessionToken(
	paths: DgPaths,
	sessionId: string,
	record: {
		sessionId: string;
		token: string;
		cwd: string;
		agentIdentity: string;
	},
): void {
	mkdirSync(paths.sessionsDir, { recursive: true, mode: 0o700 });
	const file = sessionFilePath(paths, sessionId);
	writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
}

export function removeSessionToken(paths: DgPaths, sessionId: string): void {
	rmSync(sessionFilePath(paths, sessionId), { force: true });
}

/** Slice 7's CLI verbs read the token back this way; DG_SESSION_TOKEN overrides the on-disk file. */
export function readSessionToken(paths: DgPaths, sessionId: string): string {
	const override = process.env.DG_SESSION_TOKEN;
	if (override !== undefined) return override;
	const raw = readFileSync(sessionFilePath(paths, sessionId), "utf8");
	return (JSON.parse(raw) as { token: string }).token;
}
