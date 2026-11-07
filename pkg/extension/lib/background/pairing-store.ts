import {
	CHAT_DEFAULT_PORT,
	CHAT_PORT_FALLBACK_COUNT,
	type SessionBootstrap,
	tryValidateSessionBootstrap,
} from "@dg/common";

const PAIRING_KEY_PREFIX = "pairing:";
const DISMISSED_KEY_PREFIX = "dismissed:";
const CHAT_MAX_PORT = CHAT_DEFAULT_PORT + CHAT_PORT_FALLBACK_COUNT;

export type PairingStorage = {
	get(keys?: string | string[]): Promise<Record<string, unknown>>;
	set(items: Record<string, unknown>): Promise<void>;
	remove(keys: string | string[]): Promise<void>;
};

export type PairedBootstrap = SessionBootstrap & { daemonId: string };

export type PairingStore = ReturnType<typeof createPairingStore>;

function keyOf(sessionId: string): string {
	return `${PAIRING_KEY_PREFIX}${sessionId}`;
}

function dismissedKeyOf(sessionId: string): string {
	return `${DISMISSED_KEY_PREFIX}${sessionId}`;
}

/** Validates a bootstrap and rejects ports outside the daemon's range. */
export function asSessionBootstrap(
	candidate: unknown,
): SessionBootstrap | undefined {
	const bootstrap = tryValidateSessionBootstrap(candidate);
	if (!bootstrap) return undefined;
	return bootstrap.port < CHAT_DEFAULT_PORT || bootstrap.port > CHAT_MAX_PORT
		? undefined
		: bootstrap;
}

/** A stored pairing is usable only when it carries the daemon identity it was pinned to. */
export function asPairedBootstrap(
	candidate: unknown,
): PairedBootstrap | undefined {
	const bootstrap = asSessionBootstrap(candidate);
	const { daemonId } = (candidate ?? {}) as { daemonId?: unknown };
	return bootstrap && typeof daemonId === "string" && daemonId.length > 0
		? { ...bootstrap, daemonId }
		: undefined;
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
		async list(): Promise<PairedBootstrap[]> {
			const stored = await storage.local.get();
			return Object.entries(stored ?? {}).flatMap(([key, value]) => {
				if (!key.startsWith(PAIRING_KEY_PREFIX)) return [];
				const bootstrap = asPairedBootstrap(value);
				return bootstrap ? [bootstrap] : [];
			});
		},
		put(bootstrap: PairedBootstrap): Promise<void> {
			return serialized(bootstrap.sessionId, () =>
				storage.local.set({ [keyOf(bootstrap.sessionId)]: bootstrap }),
			);
		},
		remove({ sessionId }: { sessionId: string }): Promise<void> {
			return serialized(sessionId, () =>
				storage.local.remove(keyOf(sessionId)),
			);
		},
		dismiss({ sessionId }: { sessionId: string }): Promise<void> {
			return storage.local.set({ [dismissedKeyOf(sessionId)]: true });
		},
		async isDismissed({ sessionId }: { sessionId: string }): Promise<boolean> {
			const key = dismissedKeyOf(sessionId);
			return (await storage.local.get(key))?.[key] === true;
		},
		release({ sessionId }: { sessionId: string }): Promise<void> {
			return storage.local.remove(dismissedKeyOf(sessionId));
		},
		async releaseExcept(activeSessionIds: ReadonlySet<string>): Promise<void> {
			const stale = Object.keys((await storage.local.get()) ?? {}).filter(
				(key) =>
					key.startsWith(DISMISSED_KEY_PREFIX) &&
					!activeSessionIds.has(key.slice(DISMISSED_KEY_PREFIX.length)),
			);
			if (stale.length > 0) await storage.local.remove(stale);
		},
	};
}
