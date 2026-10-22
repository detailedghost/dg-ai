import { timingSafeEqual } from "node:crypto";
import { getPublicKey, type NostrEvent, nip17, nip19, nip59 } from "nostr-tools";
import type { AbstractSimplePool, SubCloser } from "nostr-tools/pool";
import { MESSAGE_TTL_SECONDS } from "./db";

export type Message = { id: string; ts: number; from: string; text: string; call?: true };
export type Invite = { secret: string; expiresAt: number; name?: string };
export type Seen = { cursor: number; ids: string[] };
/** Who may get through: the saved contact, or a first caller who holds the invite secret. */
export type Gate = { contact?: string; invite?: Invite };

export type PhoneFriendPool = Pick<AbstractSimplePool, "publish" | "querySync" | "subscribe">;

export const GIFT_WRAP_KIND = 1059;
/** NIP-59 backdates each wrap's `created_at` by up to two days, so `since` must reach that far behind the cursor. */
export const LOOKBACK_SECONDS = 2 * 24 * 60 * 60;
const CHAT_MESSAGE_KIND = 14;
export const CALL_TAG = "dg-call";
const QUERY_MAX_WAIT_MS = 8000;
/** Caps the live subscription's non-contact id cache so relay spam cannot grow it without bound. */
export const STRANGER_ID_LIMIT = 10000;

export function wrap(text: string, sk: Uint8Array, contactPub: string): NostrEvent {
	return nip17.wrapEvent(sk, { publicKey: contactPub }, text);
}

export function ring(text: string, sk: Uint8Array, toPub: string, secret: string): NostrEvent {
	return nip59.wrapEvent(
		{ kind: CHAT_MESSAGE_KIND, content: text, tags: [["p", toPub], [CALL_TAG, secret]] },
		sk,
		toPub,
	);
}

type Rumor = ReturnType<typeof nip17.unwrapEvent>;

function open(event: NostrEvent, sk: Uint8Array): Rumor | null {
	try {
		const rumor = nip17.unwrapEvent(event, sk);
		return rumor.kind === CHAT_MESSAGE_KIND ? rumor : null;
	} catch {
		return null;
	}
}

function holdsSecret(rumor: Rumor, secret: string): boolean {
	const expected = Buffer.from(secret);
	return rumor.tags.some((tag) => {
		if (tag[0] !== CALL_TAG || typeof tag[1] !== "string") return false;
		const given = Buffer.from(tag[1]);
		return given.length === expected.length && timingSafeEqual(given, expected);
	});
}

function admit(
	event: NostrEvent,
	rumor: Rumor,
	gate: Gate,
	now: number,
): { message: Message; gate: Gate } | null {
	const message = {
		id: event.id,
		ts: rumor.created_at,
		from: nip19.npubEncode(rumor.pubkey),
		text: rumor.content,
	};
	if (gate.contact && rumor.pubkey === gate.contact) return { message, gate };
	if (gate.invite && gate.invite.expiresAt > now && holdsSecret(rumor, gate.invite.secret)) {
		return { message: { ...message, call: true }, gate: { contact: rumor.pubkey } };
	}
	return null;
}

/** Returns null for a sender the gate does not admit or a failed decrypt; never throws. */
export function unwrapIncoming(
	event: NostrEvent,
	sk: Uint8Array,
	gate: Gate,
	now: number,
): Message | null {
	const rumor = open(event, sk);
	return rumor ? (admit(event, rumor, gate, now)?.message ?? null) : null;
}

/** Never rejects on a relay failure; `ok` lists only the relays that accepted the event. */
export async function publish(
	pool: PhoneFriendPool,
	relays: string[],
	event: NostrEvent,
): Promise<{ ok: string[] }> {
	const results = await Promise.allSettled(pool.publish(relays, event));
	return { ok: relays.filter((_, i) => results[i]?.status === "fulfilled") };
}

function inboxFilter(pub: string, cursor: number, now: number) {
	return {
		kinds: [GIFT_WRAP_KIND],
		"#p": [pub],
		since: Math.max(0, cursor - LOOKBACK_SECONDS, now - MESSAGE_TTL_SECONDS),
	};
}

function remember(seen: Seen, cursor: number, ids: string[]): Seen {
	return { cursor, ids: [...seen.ids, ...ids] };
}

function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

/** Opens the whole batch first, then admits in time order, so the earliest valid call wins. */
export async function fetchNew(
	pool: PhoneFriendPool,
	relays: string[],
	sk: Uint8Array,
	gate: Gate,
	seen: Seen,
	now: () => number = nowSeconds,
): Promise<{ messages: Message[]; seen: Seen; gate: Gate }> {
	const startedAt = now();
	const events = await pool.querySync(relays, inboxFilter(getPublicKey(sk), seen.cursor, startedAt), {
		maxWait: QUERY_MAX_WAIT_MS,
	});
	const known = new Set(seen.ids);
	const opened: { event: NostrEvent; rumor: Rumor }[] = [];
	for (const event of events) {
		if (known.has(event.id)) continue;
		known.add(event.id);
		const rumor = open(event, sk);
		if (rumor) opened.push({ event, rumor });
	}
	opened.sort((a, b) => a.rumor.created_at - b.rumor.created_at);
	const messages: Message[] = [];
	let current = gate;
	for (const { event, rumor } of opened) {
		const admitted = admit(event, rumor, current, startedAt);
		if (!admitted) continue;
		messages.push(admitted.message);
		current = admitted.gate;
	}
	return {
		messages,
		seen: remember(seen, startedAt, messages.map((message) => message.id)),
		gate: current,
	};
}

export function subscribe(
	pool: PhoneFriendPool,
	relays: string[],
	sk: Uint8Array,
	gate: Gate,
	seen: Seen,
	onMessage: (message: Message, seen: Seen, gate: Gate) => void,
	now: () => number = nowSeconds,
): SubCloser {
	let state = seen;
	let current = gate;
	const known = new Set(seen.ids);
	const strangers = new Set<string>();
	return pool.subscribe(relays, inboxFilter(getPublicKey(sk), seen.cursor, now()), {
		onevent(event) {
			if (known.has(event.id) || strangers.has(event.id)) return;
			const rumor = open(event, sk);
			const admitted = rumor ? admit(event, rumor, current, now()) : null;
			if (!admitted) {
				strangers.add(event.id);
				if (strangers.size > STRANGER_ID_LIMIT) {
					strangers.delete(strangers.values().next().value as string);
				}
				return;
			}
			known.add(event.id);
			current = admitted.gate;
			state = remember(state, now(), [event.id]);
			onMessage(admitted.message, state, current);
		},
	});
}
