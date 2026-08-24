import {
	DISPATCH_MAX_CONCURRENT_DAEMON_WIDE,
	type ResolvedLimits,
} from "./limits";

type Admission = { ok: true } | { ok: false; reason: string };

const RATE_WINDOW_MS = 60_000;

export class DispatchScheduler {
	private readonly sessionInFlight = new Map<string, number>();
	private daemonInFlight = 0;
	private readonly invocationTimestamps = new Map<string, number[]>();
	private lastSweep = 0;

	tryAdmit(
		sessionId: string,
		commandLabel: string,
		limits: ResolvedLimits,
	): Admission {
		const key = JSON.stringify([sessionId, commandLabel]);
		const now = Date.now();
		if (now - this.lastSweep >= RATE_WINDOW_MS) {
			this.lastSweep = now;
			for (const [seen, times] of this.invocationTimestamps) {
				if (times.every((t) => t <= now - RATE_WINDOW_MS)) {
					this.invocationTimestamps.delete(seen);
				}
			}
		}
		const recent = (this.invocationTimestamps.get(key) ?? []).filter(
			(t) => t > now - RATE_WINDOW_MS,
		);
		if (recent.length >= limits.maxInvocationsPerMinute) {
			this.invocationTimestamps.set(key, recent);
			return {
				ok: false,
				reason: `rate limit exceeded: more than ${limits.maxInvocationsPerMinute} invocations per minute for "${commandLabel}"`,
			};
		}

		const sessionCount = this.sessionInFlight.get(sessionId) ?? 0;
		if (sessionCount >= limits.maxConcurrentPerSession) {
			return {
				ok: false,
				reason: `too many concurrent invocations for this session (max ${limits.maxConcurrentPerSession})`,
			};
		}
		if (this.daemonInFlight >= DISPATCH_MAX_CONCURRENT_DAEMON_WIDE) {
			return {
				ok: false,
				reason: `daemon is at capacity (max ${DISPATCH_MAX_CONCURRENT_DAEMON_WIDE} concurrent invocations)`,
			};
		}

		recent.push(now);
		this.invocationTimestamps.set(key, recent);
		this.sessionInFlight.set(sessionId, sessionCount + 1);
		this.daemonInFlight += 1;
		return { ok: true };
	}

	release(sessionId: string): void {
		const count = this.sessionInFlight.get(sessionId) ?? 0;
		if (count <= 1) this.sessionInFlight.delete(sessionId);
		else this.sessionInFlight.set(sessionId, count - 1);
		this.daemonInFlight = Math.max(0, this.daemonInFlight - 1);
	}
}
