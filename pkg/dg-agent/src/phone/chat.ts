import { timingSafeEqual } from "node:crypto";
import { getPublicKey, type NostrEvent, nip17, nip19, nip59 } from "nostr-tools";
import type { AbstractSimplePool, SubCloser } from "nostr-tools/pool";
import { MESSAGE_TTL_SECONDS } from "./db";

export type Message = { id: string; ts: number; from: string; text: string; call?: true };
/** The admission-time view of a contact: just enough for the gate to recognize a sender again. */
export type Contact = { npub: string; handle: string };
/** The admission-time view of a live invite: just enough for the gate to match and name a new caller, with its own relays when it has them. */
export type Invite = { secret: string; expiresAt: number; name?: string; relays?: string[] };
export type Seen = { cursor: number; ids: string[] };
/** One of our own keys, as fetchNew/subscribe need it: which pubkey a wrap may address, and the sk to open it. */
export type KeyEntry = { id: string; pub: string; sk: Uint8Array };

/** Who may get through: any saved contact, the reusable number secret, or a live one-time invite secret. */
export type Gate = {
	contacts: Map<string, Contact>;
	secrets: { number: string; invites: Invite[] };
};

export type NewContact = {
	pubkeyHex: string;
	npub: string;
	keyId: string;
	via: "number" | "invite";
	suggestedHandle: string;
	inviteSecret?: string;
	/** The matched invite's own relays; unset for a number-secret admission, which uses the default relays. */
	relays?: string[];
};
export type Reaccept = { npub: string; keyId: string };

export type Admitted = { message: Message; gate: Gate; newContact?: NewContact; reaccept?: Reaccept };

export type PhonePool = Pick<AbstractSimplePool, "publish" | "querySync" | "subscribe">;

export const GIFT_WRAP_KIND = 1059;
/** NIP-59 backdates each wrap's `created_at` by up to two days, so `since` must reach that far behind the cursor. */
export const LOOKBACK_SECONDS = 2 * 24 * 60 * 60;
const CHAT_MESSAGE_KIND = 14;
export const CALL_TAG = "dg-call";
/** Carries the caller's self-reported name, so a fresh admit can name the new contact after it. */
export const SELF_NAME_TAG = "dg-as";
/** Handle a new contact gets when neither an invite name nor a `dg-as` tag supplies one. */
export const UNKNOWN_CALLER_HANDLE = "dg";
const QUERY_MAX_WAIT_MS = 8000;
/** Caps the live subscription's non-admitted id cache so relay spam cannot grow it without bound. */
export const STRANGER_ID_LIMIT = 10000;

export function wrap(text: string, sk: Uint8Array, contactPub: string): NostrEvent {
	return nip17.wrapEvent(sk, { publicKey: contactPub }, text);
}

export function ring(text: string, sk: Uint8Array, toPub: string, secret: string, selfName: string): NostrEvent {
	return nip59.wrapEvent(
		{
			kind: CHAT_MESSAGE_KIND,
			content: text,
			tags: [["p", toPub], [CALL_TAG, secret], [SELF_NAME_TAG, selfName]],
		},
		sk,
		toPub,
	);
}

type Rumor = ReturnType<typeof nip17.unwrapEvent>;

/** Picks the key this wrap addresses, by its `p` tag, before any decrypt is attempted. */
export function pickKey(event: NostrEvent, keys: KeyEntry[]): KeyEntry | undefined {
	const addressedTo = event.tags.find((tag) => tag[0] === "p")?.[1];
	return keys.find((key) => key.pub === addressedTo);
}

function open(event: NostrEvent, sk: Uint8Array): Rumor | null {
	try {
		const rumor = nip17.unwrapEvent(event, sk);
		return rumor.kind === CHAT_MESSAGE_KIND ? rumor : null;
	} catch {
		return null;
	}
}

function holdsSecret(rumor: Rumor, secret: string): boolean {
	if (!secret) return false;
	const expected = Buffer.from(secret);
	return rumor.tags.some((tag) => {
		if (tag[0] !== CALL_TAG || typeof tag[1] !== "string") return false;
		const given = Buffer.from(tag[1]);
		return given.length === expected.length && timingSafeEqual(given, expected);
	});
}

function selfNameOf(rumor: Rumor): string | undefined {
	const value = rumor.tags.find((tag) => tag[0] === SELF_NAME_TAG)?.[1];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * A rumor older than `MESSAGE_TTL_SECONDS` is rejected outright, before any secret or contact check.
 * A known sender is always admitted; a ring that also carries the number secret is a silent
 * re-accept (the contact's `key_id` moves to whichever key the wrap was addressed to). An unknown
 * sender is admitted only by the number secret or a live invite secret, and always flagged `call`
 * so the caller announces the new contact. An invite match consumes that one invite.
 */
function admit(event: NostrEvent, rumor: Rumor, keyId: string, gate: Gate, now: number): Admitted | null {
	if (rumor.created_at < now - MESSAGE_TTL_SECONDS) return null;
	const npub = nip19.npubEncode(rumor.pubkey);
	const message: Message = { id: event.id, ts: rumor.created_at, from: npub, text: rumor.content };
	const existing = gate.contacts.get(rumor.pubkey);
	if (existing) {
		if (holdsSecret(rumor, gate.secrets.number)) {
			return { message, gate, reaccept: { npub: existing.npub, keyId } };
		}
		return { message, gate };
	}
	if (holdsSecret(rumor, gate.secrets.number)) {
		const handle = selfNameOf(rumor) ?? UNKNOWN_CALLER_HANDLE;
		const contacts = new Map(gate.contacts);
		contacts.set(rumor.pubkey, { npub, handle });
		return {
			message: { ...message, call: true },
			gate: { ...gate, contacts },
			newContact: { pubkeyHex: rumor.pubkey, npub, keyId, via: "number", suggestedHandle: handle },
		};
	}
	const invite = gate.secrets.invites.find((candidate) => candidate.expiresAt > now && holdsSecret(rumor, candidate.secret));
	if (invite) {
		const handle = invite.name ?? selfNameOf(rumor) ?? UNKNOWN_CALLER_HANDLE;
		const contacts = new Map(gate.contacts);
		contacts.set(rumor.pubkey, { npub, handle });
		return {
			message: { ...message, call: true },
			gate: {
				contacts,
				secrets: { number: gate.secrets.number, invites: gate.secrets.invites.filter((live) => live.secret !== invite.secret) },
			},
			newContact: {
				pubkeyHex: rumor.pubkey,
				npub,
				keyId,
				via: "invite",
				suggestedHandle: handle,
				inviteSecret: invite.secret,
				relays: invite.relays,
			},
		};
	}
	return null;
}

/** Returns null for a sender no held key can open or the gate does not admit; never throws. */
export function unwrapIncoming(event: NostrEvent, keys: KeyEntry[], gate: Gate, now: number): Admitted | null {
	const key = pickKey(event, keys);
	if (!key) return null;
	const rumor = open(event, key.sk);
	return rumor ? admit(event, rumor, key.id, gate, now) : null;
}

/** Never rejects on a relay failure; `ok` lists only the relays that accepted the event. */
export async function publish(pool: PhonePool, relays: string[], event: NostrEvent): Promise<{ ok: string[] }> {
	const results = await Promise.allSettled(pool.publish(relays, event));
	return { ok: relays.filter((_, i) => results[i]?.status === "fulfilled") };
}

function inboxFilter(pubs: string[], cursor: number, now: number) {
	return {
		kinds: [GIFT_WRAP_KIND],
		"#p": pubs,
		since: Math.max(0, cursor - LOOKBACK_SECONDS, now - MESSAGE_TTL_SECONDS),
	};
}

/** Keeps only the most recent `limit` entries, so a dedup list cannot grow without bound. */
export function capIds(ids: string[], limit: number): string[] {
	return ids.length > limit ? ids.slice(ids.length - limit) : ids;
}

/** Adds `value` to `set`, then evicts the oldest entry once `limit` is exceeded. */
export function addBounded<T>(set: Set<T>, value: T, limit: number): void {
	set.add(value);
	if (set.size > limit) set.delete(set.values().next().value as T);
}

function remember(seen: Seen, cursor: number, ids: string[]): Seen {
	return { cursor, ids: capIds([...seen.ids, ...ids], STRANGER_ID_LIMIT) };
}

function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

export type FetchResult = {
	messages: Message[];
	seen: Seen;
	gate: Gate;
	newContacts: NewContact[];
	reaccepts: Reaccept[];
};

/** Opens the whole batch first, then admits in time order, so the earliest valid call wins. */
export async function fetchNew(
	pool: PhonePool,
	relays: string[],
	keys: KeyEntry[],
	gate: Gate,
	seen: Seen,
	now: () => number = nowSeconds,
): Promise<FetchResult> {
	const startedAt = now();
	const events = await pool.querySync(relays, inboxFilter(keys.map((key) => key.pub), seen.cursor, startedAt), {
		maxWait: QUERY_MAX_WAIT_MS,
	});
	const known = new Set(seen.ids);
	const opened: { event: NostrEvent; rumor: Rumor; keyId: string }[] = [];
	for (const event of events) {
		if (known.has(event.id)) continue;
		known.add(event.id);
		const key = pickKey(event, keys);
		if (!key) continue;
		const rumor = open(event, key.sk);
		if (rumor) opened.push({ event, rumor, keyId: key.id });
	}
	opened.sort((a, b) => a.rumor.created_at - b.rumor.created_at);
	const messages: Message[] = [];
	const newContacts: NewContact[] = [];
	const reaccepts: Reaccept[] = [];
	let current = gate;
	for (const { event, rumor, keyId } of opened) {
		const admitted = admit(event, rumor, keyId, current, startedAt);
		if (!admitted) continue;
		messages.push(admitted.message);
		current = admitted.gate;
		if (admitted.newContact) newContacts.push(admitted.newContact);
		if (admitted.reaccept) reaccepts.push(admitted.reaccept);
	}
	return {
		messages,
		seen: remember(
			seen,
			startedAt,
			messages.map((message) => message.id),
		),
		gate: current,
		newContacts,
		reaccepts,
	};
}

export type SubscribeExtra = { newContact?: NewContact; reaccept?: Reaccept };

/**
 * Re-reads the gate from `gate()` for every event, instead of a snapshot taken once at subscribe
 * time: a contact `accept`ed or an invite consumed after the subscription opened must be visible to
 * the very next wrap, not only after the listener restarts.
 */
export function subscribe(
	pool: PhonePool,
	relays: string[],
	keys: KeyEntry[],
	gate: () => Gate,
	seen: Seen,
	onMessage: (message: Message, seen: Seen, gate: Gate, extra: SubscribeExtra) => void,
	now: () => number = nowSeconds,
): SubCloser {
	let state = seen;
	const known = new Set(seen.ids);
	const strangers = new Set<string>();
	return pool.subscribe(relays, inboxFilter(keys.map((key) => key.pub), seen.cursor, now()), {
		onevent(event) {
			if (known.has(event.id) || strangers.has(event.id)) return;
			const admitted = unwrapIncoming(event, keys, gate(), now());
			if (!admitted) {
				addBounded(strangers, event.id, STRANGER_ID_LIMIT);
				return;
			}
			addBounded(known, event.id, STRANGER_ID_LIMIT);
			state = remember(state, now(), [event.id]);
			onMessage(admitted.message, state, admitted.gate, { newContact: admitted.newContact, reaccept: admitted.reaccept });
		},
	});
}

export function npubOf(sk: Uint8Array): string {
	return nip19.npubEncode(getPublicKey(sk));
}
