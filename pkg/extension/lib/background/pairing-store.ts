import {
	CHAT_DEFAULT_PORT,
	CHAT_PORT_FALLBACK_COUNT,
	type SessionBootstrap,
	validateSessionBootstrap,
} from "@dg/common";

const PAIRING_KEY_PREFIX = "pairing:";
const CHAT_MAX_PORT = CHAT_DEFAULT_PORT + CHAT_PORT_FALLBACK_COUNT;

export type PairingStorage = {
	get(): Promise<Record<string, unknown>>;
	set(items: Record<string, unknown>): Promise<void>;
	remove(keys: string | string[]): Promise<void>;
};

export type PairingStore = ReturnType<typeof createPairingStore>;

function keyOf(sessionId: string): string {
	return `${PAIRING_KEY_PREFIX}${sessionId}`;
}

/** Validates a bootstrap and rejects ports outside the daemon's range. */
export function asSessionBootstrap(
	candidate: unknown,
): SessionBootstrap | undefined {
	try {
		const bootstrap = validateSessionBootstrap(candidate);
		if (bootstrap.port < CHAT_DEFAULT_PORT || bootstrap.port > CHAT_MAX_PORT) {
			return undefined;
		}
		return bootstrap;
	} catch {
		return undefined;
	}
}

export function createPairingStore({
	storage,
}: {
	storage: { local: PairingStorage };
}) {
	const chains = new Map<string, Promise<unknown>>();

	function serialized(sessionId: string, write: () => Promise<void>) {
		const next = (chains.get(sessionId) ?? Promise.resolve())
			.catch(() => undefined)
			.then(write);
		chains.set(sessionId, next);
		const release = () => {
			if (chains.get(sessionId) === next) chains.delete(sessionId);
		};
		next.then(release, release);
		return next;
	}

	return {
		async list(): Promise<SessionBootstrap[]> {
			const stored = await storage.local.get();
			return Object.entries(stored ?? {}).flatMap(([key, value]) => {
				if (!key.startsWith(PAIRING_KEY_PREFIX)) return [];
				const bootstrap = asSessionBootstrap(value);
				return bootstrap ? [bootstrap] : [];
			});
		},
		put(bootstrap: SessionBootstrap): Promise<void> {
			return serialized(bootstrap.sessionId, () =>
				storage.local.set({ [keyOf(bootstrap.sessionId)]: bootstrap }),
			);
		},
		remove({ sessionId }: { sessionId: string }): Promise<void> {
			return serialized(sessionId, () =>
				storage.local.remove(keyOf(sessionId)),
			);
		},
	};
}
