import { randomBytes } from "node:crypto";

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX = 16;

export type PageCodes = ReturnType<typeof createPageCodes>;

/** Short-lived single-use codes a local page trades for its session bootstrap. */
export function createPageCodes({
	now = Date.now,
	ttlMs = DEFAULT_TTL_MS,
	max = DEFAULT_MAX,
}: { now?: () => number; ttlMs?: number; max?: number } = {}) {
	const issued = new Map<string, { sessionId: string; expiresAt: number }>();

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
		mint(sessionId: string): string {
			const code = randomBytes(24).toString("base64url");
			issued.set(code, { sessionId, expiresAt: now() + ttlMs });
			prune();
			return code;
		},
		redeem(code: string): string | undefined {
			prune();
			const entry = issued.get(code);
			issued.delete(code);
			return entry?.sessionId;
		},
	};
}
