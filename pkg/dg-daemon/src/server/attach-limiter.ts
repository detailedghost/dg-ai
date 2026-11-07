const WINDOW_MS = 60_000;
const LIMIT = 30;

export type AttachLimiter = ReturnType<typeof createAttachLimiter>;

export function createAttachLimiter(now: () => number = Date.now) {
	const hits = new Map<string, number[]>();
	return {
		allow(token: string): boolean {
			const cutoff = now() - WINDOW_MS;
			for (const [key, times] of hits) {
				const recent = times.filter((time) => time > cutoff);
				if (recent.length === 0) hits.delete(key);
				else hits.set(key, recent);
			}
			const times = hits.get(token) ?? [];
			if (times.length >= LIMIT) return false;
			hits.set(token, [...times, now()]);
			return true;
		},
	};
}
