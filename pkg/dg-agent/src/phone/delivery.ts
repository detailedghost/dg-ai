import { SimplePool, verifyEvent, type NostrEvent } from "nostr-tools";
import { isCardRelays } from "./card";
import type { PhonePool } from "./chat";

/** Floor for the configurable OK wait. Below this, nos.lol's OK still loses to the old 4.4s library timeout. */
export const MIN_PUBLISH_CONFIRM_MS = 5_000;
/** Default OK wait. Covers relays that answer in about 5 to 7 seconds. */
export const DEFAULT_PUBLISH_CONFIRM_MS = 10_000;
/** Cap so a bad setting cannot pin a send for a minute per relay. */
export const MAX_PUBLISH_CONFIRM_MS = 60_000;
/** Overrides the `publish_confirm_ms` setting when set to a number. */
export const PUBLISH_CONFIRM_ENV = "DG_PHONE_PUBLISH_CONFIRM_MS";

/** NIP-17 relay list. The `relay` tags are where that pubkey reads gift wraps. */
export const INBOX_RELAY_KIND = 10050;
/** How long a successful kind 10050 lookup is reused. `now` for this cache is unix seconds. */
export const INBOX_RELAY_CACHE_SECONDS = 10 * 60;
/** Bound for one kind 10050 query. A miss still sends on the card relays and our relays. */
export const INBOX_RELAY_LOOKUP_MS = 2_000;
/** `say` and `accept` never publish to more relays than this. Inbox relays are kept first. */
export const MAX_PUBLISH_RELAYS = 10;

/** What `SimplePool` needs so a half-open socket is noticed and dialed again. */
export const PHONE_POOL_OPTIONS = { enablePing: true, enableReconnect: true } as const;

/**
 * Resolves the OK wait. The environment variable wins over the database setting.
 * An empty or non-numeric value uses the default. A number outside the floor and cap is clamped.
 */
export function resolvePublishConfirmMs(envValue: string | undefined, setting: number | undefined): number {
	const raw = envValue !== undefined && envValue.trim() !== "" ? envValue : setting !== undefined ? String(setting) : undefined;
	if (raw === undefined) return DEFAULT_PUBLISH_CONFIRM_MS;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return DEFAULT_PUBLISH_CONFIRM_MS;
	return Math.min(MAX_PUBLISH_CONFIRM_MS, Math.max(MIN_PUBLISH_CONFIRM_MS, Math.round(parsed)));
}

/** One canonical `wss://` URL, or undefined when the string cannot be published to. */
export function canonicalRelay(url: string): string | undefined {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return undefined;
	}
	if (parsed.protocol !== "wss:") return undefined;
	// `URL` already lowercases the host and drops the default 443 port.
	parsed.hash = "";
	if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) parsed.pathname = parsed.pathname.slice(0, -1);
	const canonical = parsed.pathname === "/" && parsed.search === "" ? parsed.origin : parsed.toString();
	return isCardRelays([canonical]) ? canonical : undefined;
}

function canonicalList(urls: string[]): string[] {
	const out: string[] = [];
	for (const url of urls) {
		const canonical = canonicalRelay(url);
		if (!canonical) continue;
		out.push(canonical);
	}
	return out;
}

/**
 * Union of the recipient's kind 10050 relays, the contact card relays, and our relays.
 * Duplicates collapse. The list stops at {@link MAX_PUBLISH_RELAYS}. Inbox relays come first,
 * but one card relay and one of our relays are kept even when the inbox list would fill the cap.
 */
export function publishRelaySet(input: { inbox: string[]; card: string[]; own: string[] }): string[] {
	const inbox = canonicalList(input.inbox);
	const card = canonicalList(input.card);
	const own = canonicalList(input.own);
	const keepCard = card[0];
	const keepOwn = own.find((url) => url !== keepCard);
	const protectedRelays = [keepCard, keepOwn].filter((url): url is string => url !== undefined);
	const inboxCap = MAX_PUBLISH_RELAYS - protectedRelays.length;
	const ordered = [
		...inbox.slice(0, Math.max(0, inboxCap)),
		...protectedRelays,
		...card,
		...own,
	];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const url of ordered) {
		if (seen.has(url)) continue;
		seen.add(url);
		out.push(url);
		if (out.length >= MAX_PUBLISH_RELAYS) break;
	}
	return out;
}

/** Relay URLs from one kind 10050 event. Tags other than `relay` are ignored. */
export function relaysFromInboxEvent(event: NostrEvent): string[] {
	const relays: string[] = [];
	for (const tag of event.tags) {
		if (tag[0] !== "relay" || typeof tag[1] !== "string") continue;
		const canonical = canonicalRelay(tag[1]);
		if (canonical && !relays.includes(canonical)) relays.push(canonical);
	}
	return relays;
}

export type InboxLookupCache = {
	read: () => string[] | undefined;
	write: (relays: string[]) => void;
};

/**
 * The recipient's published NIP-17 inbox relays. A cache hit skips the query.
 * A timeout or a relay error returns [] and does not cache, so the next send tries again.
 * An answer, including an empty list, is cached by the caller through `cache.write`.
 */
export async function lookupInboxRelays(
	pool: PhonePool,
	relays: string[],
	pubkey: string,
	cache: InboxLookupCache,
	timeoutMs = INBOX_RELAY_LOOKUP_MS,
): Promise<string[]> {
	const cached = cache.read();
	if (cached) return cached;
	if (relays.length === 0 || pubkey.length === 0) return [];
	let timer: ReturnType<typeof setTimeout> | undefined;
	let finished = false;
	try {
		const events = await Promise.race([
			pool
				.querySync(relays, { kinds: [INBOX_RELAY_KIND], authors: [pubkey], limit: 5 }, { maxWait: timeoutMs })
				.then((found) => {
					finished = true;
					return found;
				}),
			new Promise<NostrEvent[]>((resolve) => {
				timer = setTimeout(() => resolve([]), timeoutMs);
			}),
		]);
		if (!finished) return [];
		const trusted = events.filter((event) => event.kind === INBOX_RELAY_KIND && event.pubkey === pubkey && verifyEvent(event));
		const newest = [...trusted].sort((a, b) => b.created_at - a.created_at)[0];
		const found = newest ? relaysFromInboxEvent(newest) : [];
		cache.write(found);
		return found;
	} catch {
		return [];
	} finally {
		clearTimeout(timer);
	}
}

/** The listener pool. Ping closes a socket that stays open but is dead. Reconnect dials it again. */
export function createPhonePool(): PhonePool & { close(relays: string[]): void; destroy(): void; enablePing: boolean | undefined; enableReconnect: boolean } {
	const pool = new SimplePool({ ...PHONE_POOL_OPTIONS });
	return Object.assign(pool, {
		async armPublishTimeout(relays: string[], confirmMs: number): Promise<void> {
			await Promise.all(
				relays.map(async (url) => {
					try {
						const relay = await pool.ensureRelay(url);
						relay.publishTimeout = confirmMs;
					} catch {
						// `publish` reports the connection failure for this URL.
					}
				}),
			);
		},
	});
}
