import { timingSafeEqual } from "node:crypto";
import { getPublicKey, type NostrEvent, nip17, nip19, nip59 } from "nostr-tools";
import type { AbstractSimplePool, SubCloser } from "nostr-tools/pool";
import { MESSAGE_TTL_SECONDS } from "./db";
import { admitInPasses } from "./admit-pass";
import { relaySince } from "./since";
import {
	classifyThreadRumor,
	heldFrom,
	type HeldThread,
	sortByTime,
	threadMessageFields,
	type ThreadMeta,
} from "./thread";

export type { HeldThread, ThreadMeta };

// Stryker disable all
export type Message = { id: string; ts: number; from: string; text: string; call?: true; thread?: ThreadMeta };
/** The admission-time view of a contact: just enough for the gate to recognize a sender again. */
export type Contact = { npub: string; handle: string; keyId?: string };
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
	numberSecret?: string;
	/** The matched invite's own relays; unset for a number-secret admission, which uses the default relays. */
	relays?: string[];
};
export type Reaccept = { npub: string; keyId: string };

export type Admitted = { message: Message; gate: Gate; newContact?: NewContact; reaccept?: Reaccept };

export type PhonePool = Pick<AbstractSimplePool, "publish" | "querySync" | "subscribe"> & {
	/** Sets the OK wait on each relay before `publish`. The real pool does this; fakes omit it. */
	armPublishTimeout?(relays: string[], confirmMs: number): Promise<void>;
};

export const GIFT_WRAP_KIND = 1059;
/** NIP-59 backdates each wrap's `created_at` by up to two days, so `since` must reach that far behind the cursor. */
export const LOOKBACK_SECONDS = 2 * 24 * 60 * 60;
const CHAT_MESSAGE_KIND = 14;
export const CALL_TAG = "dg-call";
/** Carries the caller's self-reported name, so a fresh admit can name the new contact after it. */
export const SELF_NAME_TAG = "dg-as";
/** Handle a new contact gets when neither an invite name nor a `dg-as` tag supplies one. */
export const UNKNOWN_CALLER_HANDLE = "dg";
/** Topic tag on a listener liveness rumor. It sits inside the seal, so a restart can still tell a probe from mail. */
export const PROBE_TOPIC = "dg-probe";
const QUERY_MAX_WAIT_MS = 8000;
/** Caps the live subscription's non-admitted id cache so relay spam cannot grow it without bound. */
export const STRANGER_ID_LIMIT = 10000;

export function wrap(text: string, sk: Uint8Array, contactPub: string): NostrEvent {
	return nip17.wrapEvent(sk, { publicKey: contactPub }, text);
}

/** A gift wrap whose rumor is tagged as a liveness probe. The tag is inside the seal. */
export function wrapProbe(sk: Uint8Array, toPub: string): NostrEvent {
	return nip59.wrapEvent(
		{
			kind: CHAT_MESSAGE_KIND,
			content: PROBE_TOPIC,
			tags: [["p", toPub], ["t", PROBE_TOPIC]],
		},
		sk,
		toPub,
	);
}

/** True when this rumor is one of our own liveness probes. A contact cannot hide a message by adding the tag. */
export function isSelfProbe(rumor: { pubkey: string; tags: string[][] }, ownPubs: readonly string[]): boolean {
	if (!ownPubs.includes(rumor.pubkey)) return false;
	return rumor.tags.some((tag) => tag[0] === "t" && tag[1] === PROBE_TOPIC);
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
type AdmitDecision =
	| { ok: true; admitted: Admitted }
	| { ok: false; reason: "older than the message window" | "no matching contact or invite"; pubkeyPrefix: string };

function admit(event: NostrEvent, rumor: Rumor, keyId: string, gate: Gate, now: number): AdmitDecision {
	const pubkeyPrefix = shortPubkey(rumor.pubkey);
	if (rumor.created_at < now - MESSAGE_TTL_SECONDS) return { ok: false, reason: "older than the message window", pubkeyPrefix };
	const npub = nip19.npubEncode(rumor.pubkey);
	const message: Message = { id: event.id, ts: rumor.created_at, from: npub, text: rumor.content };
	const existing = gate.contacts.get(rumor.pubkey);
	if (existing) {
		if (holdsSecret(rumor, gate.secrets.number)) {
			return { ok: true, admitted: { message, gate, reaccept: { npub: existing.npub, keyId } } };
		}
		return { ok: true, admitted: { message, gate } };
	}
	if (holdsSecret(rumor, gate.secrets.number)) {
		const handle = selfNameOf(rumor) ?? UNKNOWN_CALLER_HANDLE;
		const contacts = new Map(gate.contacts);
		contacts.set(rumor.pubkey, { npub, handle, keyId });
		return {
			ok: true,
			admitted: {
				message: { ...message, call: true },
				gate: { ...gate, contacts },
				newContact: { pubkeyHex: rumor.pubkey, npub, keyId, via: "number", suggestedHandle: handle, numberSecret: gate.secrets.number },
			},
		};
	}
	const invite = gate.secrets.invites.find((candidate) => candidate.expiresAt > now && holdsSecret(rumor, candidate.secret));
	if (invite) {
		const handle = invite.name ?? selfNameOf(rumor) ?? UNKNOWN_CALLER_HANDLE;
		const contacts = new Map(gate.contacts);
		contacts.set(rumor.pubkey, { npub, handle, keyId });
		return {
			ok: true,
			admitted: {
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
			},
		};
	}
	return { ok: false, reason: "no matching contact or invite", pubkeyPrefix };
}

/** Returns null for a sender no held key can open or the gate does not admit; never throws. */
export function unwrapIncoming(event: NostrEvent, keys: KeyEntry[], gate: Gate, now: number): Admitted | null {
	const result = classifyIncoming(event, keys, gate, now);
	return "admitted" in result ? result.admitted : null;
}

/** How long `publish` waits for a relay OK when the caller does not pass `confirmMs`. The CLI passes `resolvePublishConfirmMs` instead. */
const DEFAULT_PUBLISH_CONFIRM_MS = 10_000;
/** REQ-by-id wait for a relay that did not OK in time. Capped by the confirm window. */
export const DEFAULT_PUBLISH_REQ_MS = 2_000;

export type RelayResult =
	| { relay: string; status: "ok" }
	| { relay: string; status: "rejected"; reason: string }
	| { relay: string; status: "unconfirmed"; reason: string };

export type RelayFailure = { relay: string; reason: string };

/** Per-relay outcome of one publish. `ok` kept its old meaning: relays that confirmed. */
export type PublishReport = {
	ok: string[];
	unconfirmed: string[];
	failed: RelayFailure[];
	results: RelayResult[];
};

export type PublishOptions = {
	/** Milliseconds to wait for each relay's OK. Defaults to {@link DEFAULT_PUBLISH_CONFIRM_MS}. */
	confirmMs?: number;
	/** After a timeout, REQ the event id. On by default so a late OK that already stored the event still counts. */
	confirmById?: boolean;
	/** Bound for that REQ. Defaults to the shorter of {@link DEFAULT_PUBLISH_REQ_MS} and `confirmMs`. */
	reqTimeoutMs?: number;
};

const RELAY_REASON_LIMIT = 200;

function cleanReason(reason: string): string {
	const flat = reason.replace(/[\u0000-\u001f]+/g, " ").trim();
	if (!flat) return "rejected";
	return flat.length > RELAY_REASON_LIMIT ? flat.slice(0, RELAY_REASON_LIMIT) : flat;
}

function failureReason(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	return "rejected";
}

/** nostr-tools rejects with `publish timed out` when the OK wait elapses. That is not a relay rejection. */
function isTimeoutReason(reason: string): boolean {
	const text = reason.trim().toLowerCase();
	return text === "publish timed out" || text === "timeout";
}

function reportFrom(results: RelayResult[]): PublishReport {
	return {
		results,
		ok: results.filter((result) => result.status === "ok").map((result) => result.relay),
		unconfirmed: results.filter((result) => result.status === "unconfirmed").map((result) => result.relay),
		failed: results
			.filter((result): result is Extract<RelayResult, { status: "rejected" }> => result.status === "rejected")
			.map((result) => ({ relay: result.relay, reason: result.reason })),
	};
}

async function settleRelay(relay: string, promise: Promise<string>, confirmMs: number): Promise<RelayResult> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const outcome = await Promise.race([
		promise.then(
			() => ({ kind: "ok" as const }),
			(err: unknown) => ({ kind: "error" as const, reason: cleanReason(failureReason(err)) }),
		),
		new Promise<{ kind: "timeout" }>((resolve) => {
			timer = setTimeout(() => resolve({ kind: "timeout" }), confirmMs);
		}),
	]).finally(() => clearTimeout(timer));
	if (outcome.kind === "ok") return { relay, status: "ok" };
	if (outcome.kind === "timeout" || isTimeoutReason(outcome.reason)) return { relay, status: "unconfirmed", reason: "timeout" };
	return { relay, status: "rejected", reason: outcome.reason };
}

async function relayHasEvent(pool: PhonePool, relay: string, id: string, timeoutMs: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const events = await Promise.race([
			pool.querySync([relay], { ids: [id] }, { maxWait: timeoutMs }),
			new Promise<NostrEvent[]>((resolve) => {
				timer = setTimeout(() => resolve([]), timeoutMs);
			}),
		]);
		return events.some((event) => event.id === id);
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Publishes one event and reports each relay as ok, rejected(reason), or unconfirmed(timeout).
 * A timeout is not a rejection: the event may already be stored. When `confirmById` is set, a
 * follow-up REQ upgrades that relay to ok if the event is there.
 */
export async function publish(pool: PhonePool, relays: string[], event: NostrEvent, opts: PublishOptions = {}): Promise<PublishReport> {
	const confirmMs = opts.confirmMs ?? DEFAULT_PUBLISH_CONFIRM_MS;
	const confirmById = opts.confirmById ?? true;
	const reqTimeoutMs = opts.reqTimeoutMs ?? Math.min(DEFAULT_PUBLISH_REQ_MS, confirmMs);
	await pool.armPublishTimeout?.(relays, confirmMs);
	const settled = await Promise.all(pool.publish(relays, event).map((promise, index) => settleRelay(relays[index] ?? "", promise, confirmMs)));
	if (confirmById) {
		await Promise.all(
			settled.map(async (result, index) => {
				if (result.status !== "unconfirmed") return;
				const relay = relays[index];
				if (!relay) return;
				if (await relayHasEvent(pool, relay, event.id, reqTimeoutMs)) settled[index] = { relay, status: "ok" };
			}),
		);
	}
	return reportFrom(settled);
}

/** True when at least one relay did not explicitly reject. An empty target list does not count. */
export function shouldSaveOutgoing(report: PublishReport): boolean {
	return report.results.some((result) => result.status !== "rejected");
}

// Stryker restore all
function inboxFilter(pubs: string[], cursor: number, now: number) {
	return {
		kinds: [GIFT_WRAP_KIND],
		"#p": pubs,
		since: relaySince(cursor, now, LOOKBACK_SECONDS, MESSAGE_TTL_SECONDS),
	};
}
// Stryker disable all

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
	/** Re-accepts keyed by the wrap that carried the number secret, so a later plain message in the same batch does not move the key. */
	reacceptByMessageId: Map<string, Reaccept>;
	/** Thread rumors that were not admitted. The listener holds these and does not store them as mail. */
	held: HeldThread[];
};

/** Opens the whole batch first, then admits in time order, so the earliest valid call wins. */
export async function fetchNew(
	pool: PhonePool,
	relays: string[],
	keys: KeyEntry[],
	gate: Gate,
	seen: Seen,
	now: () => number = nowSeconds,
	onDrop?: (drop: DroppedRing) => void,
): Promise<FetchResult> {
	const startedAt = now();
	const events = await pool.querySync(relays, inboxFilter(keys.map((key) => key.pub), seen.cursor, startedAt), {
		maxWait: QUERY_MAX_WAIT_MS,
	});
	const known = new Set(seen.ids);
	const ownPubs = keys.map((held) => held.pub);
	const opened: { event: NostrEvent; rumor: Rumor; keyId: string }[] = [];
	const skipped: string[] = [];
	for (const event of events) {
		if (known.has(event.id)) continue;
		known.add(event.id);
		const key = pickKey(event, keys);
		if (!key) continue;
		const rumor = open(event, key.sk);
		if (!rumor) continue;
		if (isSelfProbe(rumor, ownPubs)) {
			skipped.push(event.id);
			continue;
		}
		opened.push({ event, rumor, keyId: key.id });
	}
	opened.sort((a, b) => a.rumor.created_at - b.rumor.created_at);
	const messages: Message[] = [];
	const newContacts: NewContact[] = [];
	const reaccepts: Reaccept[] = [];
	const reacceptByMessageId = new Map<string, Reaccept>();
	const held: HeldThread[] = [];
	const direct: typeof opened = [];
	const deferredThreads: typeof opened = [];
	const threadContactsOf = (source: Gate) => [...source.contacts.entries()].map(([pub, contact]) => ({ pub, keyId: contact.keyId }));
	const classifyItem = (item: (typeof opened)[number], source: Gate) => {
		const openingPub = keys.find((key) => key.id === item.keyId)?.pub ?? "";
		return classifyThreadRumor(item.rumor, ownPubs, threadContactsOf(source), startedAt, item.keyId, openingPub);
	};
	const keepThread = (item: (typeof opened)[number], view: NonNullable<ReturnType<typeof classifyThreadRumor>>) => {
		if (view.kind === "hold") {
			held.push(heldFrom(view));
			skipped.push(item.event.id);
			return;
		}
		if (view.kind === "message") {
			messages.push(threadMessageFields(view, view.keyId ?? item.keyId));
			skipped.push(item.event.id);
			return;
		}
		onDrop?.({ id: item.event.id, reason: view.reason ?? "older than the message window", pubkeyPrefix: view.pubkeyPrefix });
	};
	for (const item of opened) {
		const view = classifyItem(item, gate);
		if (view === null) {
			direct.push(item);
			continue;
		}
		if (view.kind === "drop" && view.reason === "no matching contact or invite") {
			deferredThreads.push(item);
			continue;
		}
		keepThread(item, view);
	}
	let current = gate;
	// Stryker restore all
	const { admitted, drops } = admitInPasses(direct, (item) => {
		const decided = admit(item.event, item.rumor, item.keyId, current, startedAt);
		if (!decided.ok) {
			return {
				ok: false,
				retry: decided.reason === "no matching contact or invite",
				drop: { id: item.event.id, reason: decided.reason, pubkeyPrefix: decided.pubkeyPrefix },
			};
		}
		current = decided.admitted.gate;
		return { ok: true, value: decided.admitted, grew: decided.admitted.newContact !== undefined };
	});
	for (const drop of drops) onDrop?.(drop);
	for (const item of admitted) {
		messages.push(item.message);
		if (item.newContact) newContacts.push(item.newContact);
		if (item.reaccept) {
			reaccepts.push(item.reaccept);
			reacceptByMessageId.set(item.message.id, item.reaccept);
		}
	}
	for (const item of deferredThreads) {
		const view = classifyItem(item, current);
		if (view === null) continue;
		keepThread(item, view);
	}
	sortByTime(messages);
	return {
		messages,
		seen: remember(seen, startedAt, [...messages.map((message) => message.id), ...skipped]),
		gate: current,
		newContacts,
		reaccepts,
		reacceptByMessageId,
		held,
	};
}
// Stryker disable all

export type SubscribeExtra = { newContact?: NewContact; reaccept?: Reaccept };

/** First hex chars of a pubkey. Long enough to tell senders apart, short enough to not be the key. */
export const PUBKEY_PREFIX_LEN = 8;

export type DropReason =
	| "not addressed to a loaded key"
	| "could not open the wrap"
	| "not a chat message"
	| "older than the message window"
	| "no matching contact or invite"
	| "thread is too large"
	| "ahead of the clock";

/** Why a wrap was not stored. No secret, invite secret, or message text. */
export type DroppedRing = { id: string; reason: DropReason; pubkeyPrefix?: string };

export function shortPubkey(pub: string): string {
	return pub.slice(0, PUBKEY_PREFIX_LEN);
}

type Opened = { kind: "ok"; rumor: Rumor } | { kind: "undecryptable" } | { kind: "not-chat" };

function openDetailed(event: NostrEvent, sk: Uint8Array): Opened {
	try {
		const rumor = nip17.unwrapEvent(event, sk);
		return rumor.kind === CHAT_MESSAGE_KIND ? { kind: "ok", rumor } : { kind: "not-chat" };
	} catch {
		return { kind: "undecryptable" };
	}
}

function open(event: NostrEvent, sk: Uint8Array): Rumor | null {
	const opened = openDetailed(event, sk);
	return opened.kind === "ok" ? opened.rumor : null;
}

/**
 * One look at a wrap: admitted, or a drop reason. `pubkeyPrefix` is set only after the rumor opens.
 */
export function classifyIncoming(
	event: NostrEvent,
	keys: KeyEntry[],
	gate: Gate,
	now: number,
	ownPubs: readonly string[] = keys.map((held) => held.pub),
): { admitted: Admitted } | { drop: DroppedRing } | { probe: true } | { held: HeldThread } {
	const key = pickKey(event, keys);
	if (!key) return { drop: { id: event.id, reason: "not addressed to a loaded key" } };
	const opened = openDetailed(event, key.sk);
	if (opened.kind === "undecryptable") return { drop: { id: event.id, reason: "could not open the wrap" } };
	if (opened.kind === "not-chat") return { drop: { id: event.id, reason: "not a chat message" } };
	if (isSelfProbe(opened.rumor, ownPubs)) return { probe: true };
	const threadContacts = [...gate.contacts.entries()].map(([pub, contact]) => ({ pub, keyId: contact.keyId }));
	const view = classifyThreadRumor(opened.rumor, ownPubs, threadContacts, now, key.id, key.pub);
	if (view?.kind === "drop") {
		return { drop: { id: event.id, reason: view.reason ?? "older than the message window", pubkeyPrefix: view.pubkeyPrefix } };
	}
	if (view?.kind === "hold") return { held: heldFrom(view) };
	if (view?.kind === "message") return { admitted: { message: threadMessageFields(view, view.keyId ?? key.id), gate } };
	const decided = admit(event, opened.rumor, key.id, gate, now);
	if (!decided.ok) return { drop: { id: event.id, reason: decided.reason, pubkeyPrefix: decided.pubkeyPrefix } };
	return { admitted: decided.admitted };
}

export type SubscribeHooks = {
	/** Called once when `gate()` does not admit, before the event is dropped. */
	reread?: () => Gate;
	onDrop?: (drop: DroppedRing) => void;
	/** Called for every event the subscription delivers, before admission. Used by the liveness probe. */
	onEvent?: (id: string) => void;
	/** A thread rumor that was not admitted. The body stays out of the log line the listener prints. */
	onHeld?: (held: HeldThread) => void;
};

/**
 * Calls `gate()` for every event. On a miss, `reread` runs once and the event is tried again
 * before it is dropped, so an invite saved after this subscription opened can still admit.
 */
export function subscribe(
	pool: PhonePool,
	relays: string[],
	keys: KeyEntry[],
	gate: () => Gate,
	seen: Seen,
	onMessage: (message: Message, seen: Seen, gate: Gate, extra: SubscribeExtra) => void,
	now: () => number = nowSeconds,
	hooks: SubscribeHooks = {},
): SubCloser {
	let state = seen;
	const known = new Set(seen.ids);
	const strangers = new Set<string>();
	const ownPubs = keys.map((held) => held.pub);
	return pool.subscribe(relays, inboxFilter(ownPubs, seen.cursor, now()), {
		onevent(event) {
			hooks.onEvent?.(event.id);
			if (known.has(event.id) || strangers.has(event.id)) return;
			let result = classifyIncoming(event, keys, gate(), now(), ownPubs);
			if (!("admitted" in result) && !("probe" in result) && hooks.reread) {
				result = classifyIncoming(event, keys, hooks.reread(), now(), ownPubs);
			}
			if ("probe" in result) {
				addBounded(known, event.id, STRANGER_ID_LIMIT);
				return;
			}
			if ("held" in result) {
				hooks.onHeld?.(result.held);
				addBounded(known, event.id, STRANGER_ID_LIMIT);
				return;
			}
			if (!("admitted" in result)) {
				hooks.onDrop?.(result.drop);
				addBounded(strangers, event.id, STRANGER_ID_LIMIT);
				return;
			}
			addBounded(known, event.id, STRANGER_ID_LIMIT);
			state = remember(state, now(), [event.id]);
			onMessage(result.admitted.message, state, result.admitted.gate, {
				newContact: result.admitted.newContact,
				reaccept: result.admitted.reaccept,
			});
		},
	});
}

export function npubOf(sk: Uint8Array): string {
	return nip19.npubEncode(getPublicKey(sk));
}
