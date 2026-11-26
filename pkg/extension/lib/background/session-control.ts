import { createSerialQueue } from "@dg/common";
import type { AgentTabsStorage } from "./agent-tabs";

/** Most sites one session keeps allowed; the oldest drops out first. */
export const MAX_SESSION_SITES = 100;

export const STOP_TTL_MS = 24 * 60 * 60 * 1000;

export const stopExpired = (stoppedAt: number): boolean => Date.now() - stoppedAt > STOP_TTL_MS;

const STOPPED_PREFIX = "pwExtStopped:";
const sitesKey = (sessionId: string) => `pwExtSites:${sessionId}`;
const stoppedKey = (sessionId: string) => `${STOPPED_PREFIX}${sessionId}`;
const valuesKey = (sessionId: string) => `pwExtValues:${sessionId}`;

/** Per-session site allowlist, network values grants and Stop state in storage.session; sites and values grants end with the session or on Stop. A Stop holds for 24 hours; the daemon refuses the session for good, so expiry only frees this record. */
export function createSessionControl({ storage }: { storage: AgentTabsStorage }) {
	const enqueue = createSerialQueue();

	function exclusive<T>(task: () => Promise<T>): Promise<T> {
		let outcome: { value: T } | { error: unknown } | undefined;
		return enqueue(async () => {
			try {
				outcome = { value: await task() };
			} catch (error) {
				outcome = { error };
			}
		}).then(() => {
			if (outcome && "value" in outcome) return outcome.value;
			throw outcome && "error" in outcome ? outcome.error : new Error("session control task did not run");
		});
	}

	async function sites(sessionId: string): Promise<string[]> {
		const stored = (await storage.session.get(sitesKey(sessionId)))[sitesKey(sessionId)];
		return Array.isArray(stored) ? stored.filter((site): site is string => typeof site === "string") : [];
	}

	async function valueSites(sessionId: string): Promise<string[]> {
		const stored = (await storage.session.get(valuesKey(sessionId)))[valuesKey(sessionId)];
		return Array.isArray(stored) ? stored.filter((site): site is string => typeof site === "string") : [];
	}

	async function readStopped(sessionId: string): Promise<boolean> {
		const key = stoppedKey(sessionId);
		const held = (await storage.session.get(key))[key];
		if (held === true) {
			await storage.session.set({ [key]: Date.now() });
			return true;
		}
		if (typeof held !== "number") return false;
		if (!stopExpired(held)) return true;
		await storage.session.remove(key);
		return false;
	}

	async function scanStopped(): Promise<{ live: string[]; expired: string[] }> {
		const live: string[] = [];
		const expired: string[] = [];
		for (const [key, held] of Object.entries(await storage.session.get(null))) {
			if (!key.startsWith(STOPPED_PREFIX) || typeof held !== "number") continue;
			if (stopExpired(held)) expired.push(key);
			else live.push(key.slice(STOPPED_PREFIX.length));
		}
		return { live, expired };
	}

	async function sweep(): Promise<string[]> {
		const { live, expired } = await scanStopped();
		for (const key of expired) await storage.session.remove(key);
		return live;
	}

	return {
		/** Reads without the queue unless the record needs a write, so a Stop never waits behind a plain read. */
		async stopped(sessionId: string): Promise<boolean> {
			const key = stoppedKey(sessionId);
			const held = (await storage.session.get(key))[key];
			if (held === undefined) return false;
			if (typeof held === "number" && !stopExpired(held)) return true;
			return exclusive(() => readStopped(sessionId));
		},

		async stoppedIds(): Promise<string[]> {
			const { live, expired } = await scanStopped();
			return expired.length === 0 ? live : exclusive(sweep);
		},

		async allowed(sessionId: string, site: string): Promise<boolean> {
			return (await sites(sessionId)).includes(site);
		},

		allow(sessionId: string, site: string): Promise<void> {
			return enqueue(async () => {
				if (await readStopped(sessionId)) return;
				const held = await sites(sessionId);
				if (held.includes(site)) return;
				await storage.session.set({ [sitesKey(sessionId)]: [...held, site].slice(-MAX_SESSION_SITES) });
			});
		},

		async valuesAllowed(sessionId: string, site: string): Promise<boolean> {
			return (await valueSites(sessionId)).includes(site);
		},

		/** Records the person's one Allow to show network values on a site for the rest of the session. */
		allowValues(sessionId: string, site: string): Promise<void> {
			return enqueue(async () => {
				if (await readStopped(sessionId)) return;
				const held = await valueSites(sessionId);
				if (held.includes(site)) return;
				await storage.session.set({ [valuesKey(sessionId)]: [...held, site].slice(-MAX_SESSION_SITES) });
			});
		},

		/** Marks the session stopped by the person, sweeps expired stops, and drops its allowed sites and values grants. */
		stop(sessionId: string): Promise<void> {
			return enqueue(async () => {
				await storage.session.set({ [stoppedKey(sessionId)]: Date.now() });
				await storage.session.remove(sitesKey(sessionId));
				await storage.session.remove(valuesKey(sessionId));
				await sweep();
			});
		},

		/** Drops the session's allowed sites and values grants; a Stop stays. */
		forget(sessionId: string): Promise<void> {
			return enqueue(async () => {
				await storage.session.remove(sitesKey(sessionId));
				await storage.session.remove(valuesKey(sessionId));
				await sweep();
			});
		},
	};
}

export type SessionControl = ReturnType<typeof createSessionControl>;
