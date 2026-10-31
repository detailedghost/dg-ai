import { createHash, timingSafeEqual } from "node:crypto";

export function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

export function tokenMatches(token: string, hash: string): boolean {
	if (!/^[0-9a-f]{64}$/.test(hash)) return false;
	const actual = Buffer.from(hashToken(token), "hex");
	const expected = Buffer.from(hash, "hex");
	if (actual.length !== expected.length) return false;
	return timingSafeEqual(actual, expected);
}
