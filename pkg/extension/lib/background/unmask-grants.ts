import type { AgentTabsStorage } from "./agent-tabs";

/** A user-approved unmask for one site in one agent tab group, until a time. */
export type UnmaskGrant = { origin: string; groupId: number; until: number };

const keyOf = (sessionId: string) => `pwExtUnmask:${sessionId}`;

/** Unmask grants per session in storage.session; a grant ends at its time, on revoke, or when its tab group is gone. */
export function createUnmaskGrants({
	storage,
	now = Date.now,
}: {
	storage: AgentTabsStorage;
	now?: () => number;
}) {
	async function read(sessionId: string): Promise<UnmaskGrant[]> {
		const stored = (await storage.session.get(keyOf(sessionId)))[keyOf(sessionId)];
		return Array.isArray(stored) ? (stored as UnmaskGrant[]).filter((grant) => grant.until > now()) : [];
	}

	async function write(sessionId: string, grants: UnmaskGrant[]): Promise<void> {
		if (grants.length) await storage.session.set({ [keyOf(sessionId)]: grants });
		else await storage.session.remove(keyOf(sessionId));
	}

	let queue: Promise<unknown> = Promise.resolve();
	function serial<T>(update: () => Promise<T>): Promise<T> {
		const next = queue.then(update, update);
		queue = next.catch(() => undefined);
		return next;
	}

	return {
		async active(
			sessionId: string,
			tab: { url?: string; groupId?: number },
		): Promise<UnmaskGrant | undefined> {
			if (!tab.url) return undefined;
			const origin = new URL(tab.url).origin;
			return (await read(sessionId)).find(
				(grant) => grant.origin === origin && grant.groupId === tab.groupId,
			);
		},

		grant(sessionId: string, grant: UnmaskGrant): Promise<void> {
			return serial(async () => {
				const others = (await read(sessionId)).filter((held) => held.origin !== grant.origin);
				await write(sessionId, [...others, grant]);
			});
		},

		revoke(sessionId: string, origin: string): Promise<boolean> {
			return serial(async () => {
				const held = await read(sessionId);
				const kept = held.filter((grant) => grant.origin !== origin);
				await write(sessionId, kept);
				return kept.length !== held.length;
			});
		},
	};
}

export type UnmaskGrants = ReturnType<typeof createUnmaskGrants>;
