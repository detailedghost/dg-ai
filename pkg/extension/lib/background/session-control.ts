import { createSerialQueue } from "@dg/common";
import type { AgentTabsStorage } from "./agent-tabs";

/** Most sites one session keeps allowed; the oldest drops out first. */
export const MAX_SESSION_SITES = 100;

const sitesKey = (sessionId: string) => `pwExtSites:${sessionId}`;
const stoppedKey = (sessionId: string) => `pwExtStopped:${sessionId}`;

/** Per-session site allowlist and Stop state in storage.session; sites end with the session, and Stop holds until the browser ends, so a session id that comes back stays stopped. */
export function createSessionControl({ storage }: { storage: AgentTabsStorage }) {
	const enqueue = createSerialQueue();

	async function sites(sessionId: string): Promise<string[]> {
		const stored = (await storage.session.get(sitesKey(sessionId)))[sitesKey(sessionId)];
		return Array.isArray(stored) ? stored.filter((site): site is string => typeof site === "string") : [];
	}

	async function stopped(sessionId: string): Promise<boolean> {
		return (await storage.session.get(stoppedKey(sessionId)))[stoppedKey(sessionId)] === true;
	}

	return {
		stopped,

		async allowed(sessionId: string, site: string): Promise<boolean> {
			return (await sites(sessionId)).includes(site);
		},

		allow(sessionId: string, site: string): Promise<void> {
			return enqueue(async () => {
				if (await stopped(sessionId)) return;
				const held = await sites(sessionId);
				if (held.includes(site)) return;
				await storage.session.set({ [sitesKey(sessionId)]: [...held, site].slice(-MAX_SESSION_SITES) });
			});
		},

		/** Marks the session stopped by the person and drops its allowed sites. */
		stop(sessionId: string): Promise<void> {
			return enqueue(async () => {
				await storage.session.set({ [stoppedKey(sessionId)]: true });
				await storage.session.remove(sitesKey(sessionId));
			});
		},

		/** Drops the session's allowed sites; a Stop stays. */
		forget(sessionId: string): Promise<void> {
			return enqueue(() => storage.session.remove(sitesKey(sessionId)));
		},
	};
}

export type SessionControl = ReturnType<typeof createSessionControl>;
