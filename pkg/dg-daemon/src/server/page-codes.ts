import { randomBytes } from "node:crypto";

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX = 16;

export const SECRET_INTENT_TTL_MS = 120_000;

export type PageCodes<T = string> = {
	mint(payload: T): string;
	peek(code: string): T | undefined;
	redeem(code: string): T | undefined;
};

/** Short-lived single-use codes a local page trades for its payload; peek reads without spending the code. */
export function createPageCodes<T = string>({
	now = Date.now,
	ttlMs = DEFAULT_TTL_MS,
	max = DEFAULT_MAX,
}: { now?: () => number; ttlMs?: number; max?: number } = {}): PageCodes<T> {
	const issued = new Map<string, { payload: T; expiresAt: number }>();

	function prune(): void {
		const current = now();
		for (const [code, entry] of issued) {
			if (entry.expiresAt <= current) issued.delete(code);
		}
		while (issued.size > max) {
			const oldest = issued.keys().next().value;
			if (oldest === undefined) break;
			issued.delete(oldest);
		}
	}

	return {
		mint(payload) {
			const code = randomBytes(24).toString("base64url");
			issued.set(code, { payload, expiresAt: now() + ttlMs });
			prune();
			return code;
		},
		peek(code) {
			prune();
			return issued.get(code)?.payload;
		},
		redeem(code) {
			prune();
			const entry = issued.get(code);
			issued.delete(code);
			return entry?.payload;
		},
	};
}
