import type { SessionBootstrap } from "@dg/common";
import { CHAT_SESSION_KEY_PREFIX } from "@dg/pages/chat-messages";

export type PairingStorage = {
	get?(): Promise<Record<string, unknown>>;
	set(items: Record<string, unknown>): Promise<void>;
	remove(keys: string | string[]): Promise<void>;
};

export type PairingStore = ReturnType<typeof createPairingStore>;

function keyOf(sessionId: string): string {
	return `${CHAT_SESSION_KEY_PREFIX}${sessionId}`;
}

export function createPairingStore({
	storage,
}: {
	storage: { session: PairingStorage };
}) {
	return {
		async list(): Promise<SessionBootstrap[]> {
			if (!storage.session.get) return [];
			const stored = await storage.session.get();
			return Object.entries(stored ?? {})
				.filter(([key]) => key.startsWith(CHAT_SESSION_KEY_PREFIX))
				.map(([, value]) => value as SessionBootstrap);
		},
		put(bootstrap: SessionBootstrap): Promise<void> {
			return storage.session.set({ [keyOf(bootstrap.sessionId)]: bootstrap });
		},
		remove({ sessionId }: { sessionId: string }): Promise<void> {
			return storage.session.remove(keyOf(sessionId));
		},
	};
}
