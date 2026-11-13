import { createSerialQueue } from "@dg/common";
import type { AgentTabsStorage } from "./agent-tabs";

/** Most origins one session keeps allowed; the oldest drops out first. */
export const MAX_SESSION_SITES = 100;

const sitesKey = (sessionId: string) => `pwExtSites:${sessionId}`;
const stoppedKey = (sessionId: string) => `pwExtStopped:${sessionId}`;
const valuesKey = (sessionId: string) => `pwExtValues:${sessionId}`;

/** Per-session site allowlist, network values grants and Stop state in storage.session; sites and values grants end with the session or on Stop, and Stop holds until the browser ends, so a session id that comes back stays stopped. */
export function createSessionControl({ storage }: { storage: AgentTabsStorage }) {
	const enqueue = createSerialQueue();

	async function sites(sessionId: string): Promise<string[]> {
		const stored = (await storage.session.get(sitesKey(sessionId)))[sitesKey(sessionId)];
		return Array.isArray(stored) ? stored.filter((site): site is string => typeof site === "string") : [];
	}

	async function valueSites(sessionId: string): Promise<string[]> {
		const stored = (await storage.session.get(valuesKey(sessionId)))[valuesKey(sessionId)];
		return Array.isArray(stored) ? stored.filter((site): site is string => typeof site === "string") : [];
	}

	async function stopped(sessionId: string): Promise<boolean> {
		return (await storage.session.get(stoppedKey(sessionId)))[stoppedKey(sessionId)] === true;
	}

	return {
		stopped,

		async allowed(sessionId: string, origin: string): Promise<boolean> {
			return (await sites(sessionId)).includes(origin);
		},

		allow(sessionId: string, origin: string): Promise<void> {
			return enqueue(async () => {
				if (await stopped(sessionId)) return;
				const held = await sites(sessionId);
				if (held.includes(origin)) return;
				await storage.session.set({ [sitesKey(sessionId)]: [...held, origin].slice(-MAX_SESSION_SITES) });
			});
		},

		async valuesAllowed(sessionId: string, site: string): Promise<boolean> {
			return (await valueSites(sessionId)).includes(site);
		},

		/** Records the person's one Allow to show network values on a site for the rest of the session. */
		allowValues(sessionId: string, site: string): Promise<void> {
			return enqueue(async () => {
				if (await stopped(sessionId)) return;
				const held = await valueSites(sessionId);
				if (held.includes(site)) return;
				await storage.session.set({ [valuesKey(sessionId)]: [...held, site].slice(-MAX_SESSION_SITES) });
			});
		},

		/** Marks the session stopped by the person and drops its allowed sites and values grants. */
		stop(sessionId: string): Promise<void> {
			return enqueue(async () => {
				await storage.session.set({ [stoppedKey(sessionId)]: true });
				await storage.session.remove(sitesKey(sessionId));
				await storage.session.remove(valuesKey(sessionId));
			});
		},

		/** Drops the session's allowed sites and values grants; a Stop stays. */
		forget(sessionId: string): Promise<void> {
			return enqueue(async () => {
				await storage.session.remove(sitesKey(sessionId));
				await storage.session.remove(valuesKey(sessionId));
			});
		},
	};
}

export type SessionControl = ReturnType<typeof createSessionControl>;
