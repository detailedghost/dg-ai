import { getPublicKey, type NostrEvent, nip17, nip19 } from "nostr-tools";
import type { AbstractSimplePool, SubCloser } from "nostr-tools/pool";
import { remember, type Seen } from "./store";

export type Message = { id: string; ts: number; from: string; text: string };

export type PhonePool = Pick<AbstractSimplePool, "publish" | "querySync" | "subscribe">;

export const GIFT_WRAP_KIND = 1059;
/** NIP-59 backdates each wrap's `created_at` by up to two days, so `since` must reach that far behind the cursor. */
export const LOOKBACK_SECONDS = 2 * 24 * 60 * 60;
const CHAT_MESSAGE_KIND = 14;
const QUERY_MAX_WAIT_MS = 8000;
/** Caps the live subscription's non-peer id cache so relay spam cannot grow it without bound. */
export const STRANGER_ID_LIMIT = 10000;

export function wrap(text: string, sk: Uint8Array, peerPub: string): NostrEvent {
	return nip17.wrapEvent(sk, { publicKey: peerPub }, text);
}

/** Returns null for a non-peer sender or a failed decrypt; never throws. */
export function unwrapFromPeer(
	event: NostrEvent,
	sk: Uint8Array,
	peerPub: string,
): Message | null {
	try {
		const rumor = nip17.unwrapEvent(event, sk);
		if (rumor.kind !== CHAT_MESSAGE_KIND || rumor.pubkey !== peerPub) return null;
		return {
			id: event.id,
			ts: rumor.created_at,
			from: nip19.npubEncode(rumor.pubkey),
			text: rumor.content,
		};
	} catch {
		return null;
	}
}

/** Never rejects on a relay failure; `ok` lists only the relays that accepted the event. */
export async function publish(
	pool: PhonePool,
	relays: string[],
	event: NostrEvent,
): Promise<{ ok: string[] }> {
	const results = await Promise.allSettled(pool.publish(relays, event));
	return { ok: relays.filter((_, i) => results[i]?.status === "fulfilled") };
}

function inboxFilter(pub: string, cursor: number) {
	return {
		kinds: [GIFT_WRAP_KIND],
		"#p": [pub],
		since: Math.max(0, cursor - LOOKBACK_SECONDS),
	};
}

/** Dedupes within this batch too, since each relay returns its own copy of a wrap. */
export async function fetchNew(
	pool: PhonePool,
	relays: string[],
	sk: Uint8Array,
	peerPub: string,
	seen: Seen,
	now: () => number = () => Math.floor(Date.now() / 1000),
): Promise<{ messages: Message[]; seen: Seen }> {
	const startedAt = now();
	const events = await pool.querySync(relays, inboxFilter(getPublicKey(sk), seen.cursor), {
		maxWait: QUERY_MAX_WAIT_MS,
	});
	const known = new Set(seen.ids);
	const messages: Message[] = [];
	for (const event of events) {
		if (known.has(event.id)) continue;
		known.add(event.id);
		const message = unwrapFromPeer(event, sk, peerPub);
		if (message) messages.push(message);
	}
	messages.sort((a, b) => a.ts - b.ts);
	return {
		messages,
		seen: remember({ ...seen, cursor: startedAt }, messages.map((message) => message.id)),
	};
}

export function subscribe(
	pool: PhonePool,
	relays: string[],
	sk: Uint8Array,
	peerPub: string,
	seen: Seen,
	onMessage: (message: Message, seen: Seen) => void,
): SubCloser {
	let state = seen;
	const known = new Set(seen.ids);
	const strangers = new Set<string>();
	return pool.subscribe(relays, inboxFilter(getPublicKey(sk), seen.cursor), {
		onevent(event) {
			if (known.has(event.id) || strangers.has(event.id)) return;
			const message = unwrapFromPeer(event, sk, peerPub);
			if (!message) {
				strangers.add(event.id);
				if (strangers.size > STRANGER_ID_LIMIT) {
					strangers.delete(strangers.values().next().value as string);
				}
				return;
			}
			known.add(event.id);
			state = remember({ ...state, cursor: Math.floor(Date.now() / 1000) }, [event.id]);
			onMessage(message, state);
		},
	});
}
