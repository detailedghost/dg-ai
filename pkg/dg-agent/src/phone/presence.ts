import { nip19 } from "nostr-tools";
import {
	ACK_TAG,
	BUSY_TAG,
	type ControlRumor,
	createReplayGuard,
	type KeyEntry,
	type Message,
	type PhonePool,
	PRESENCE_KIND,
	publish,
	RECEIPT_KIND,
	wrapEphemeral,
	wrapTagged,
} from "./chat";
import type { PhoneDb } from "./db";
import { contactRelays, findContactByNpub, listContacts, pubkeyHex, readPresenceOn } from "./store";
import { REQUEST_SKEW_SECONDS, SEEN_LIMIT } from "./transport";

/** Lower bound of the jittered gap between presence beats. */
export const PRESENCE_MIN_MS = 4 * 60 * 1000;
/** Upper bound of the jittered gap between presence beats. */
export const PRESENCE_MAX_MS = 6 * 60 * 1000;
/** Contacts one beat reaches; the next beat starts after the last one reached. */
export const PRESENCE_FANOUT = 16;
/** A contact silent this long counts as offline, so its next rumor retries pending image fetches. */
export const ONLINE_GAP_SECONDS = (2 * PRESENCE_MAX_MS) / 1000;
/** Message ids one receipt rumor names. */
export const RECEIPT_IDS_PER_RUMOR = 32;
/** Unsent receipt ids held per contact; more are dropped. */
export const RECEIPT_BACKLOG = 256;
/** Ping checks one contact gets a normal answer to in `PING_WINDOW_SECONDS`. */
export const PING_ANSWER_CAP = 10;
/** Busy answers one contact gets in the same window; later checks get no answer. */
export const BUSY_ANSWER_CAP = 10;
const PING_WINDOW_SECONDS = 60;
const SEEN_SECONDS = 60 * 60;
const ID_PATTERN = /^[0-9a-f]{64}$/;

export type PresenceConfig = { minMs: number; maxMs: number; random: () => number };

export type PresenceDeps = {
	db: PhoneDb;
	pool: PhonePool;
	now: () => number;
	keys: () => readonly KeyEntry[];
	confirmMs: number;
	/** A contact (hex pubkey) sent a rumor after a silence of at least `ONLINE_GAP_SECONDS`. */
	onOnline: (pub: string) => void;
};

export type Presence = {
	/** A receipt or presence rumor from the subscription; anything not fresh, new, and from a contact is ignored. */
	handle(control: ControlRumor): void;
	/** A message the listener just stored: answers it with a receipt and records the sender as seen. */
	stored(message: Message): void;
	/** Sends one presence rumor to each of the next `PRESENCE_FANOUT` contacts. */
	beat(): Promise<void>;
	stop(): void;
	settle(): Promise<void>;
};

/** Fresh within the request skew, not seen before, and from a contact; returns the contact's npub. */
export function acceptControl(db: PhoneDb, seen: ReturnType<typeof createReplayGuard>, control: ControlRumor, now: number): string | undefined {
	if (Math.abs(now - control.createdAt) > REQUEST_SKEW_SECONDS) return undefined;
	const npub = nip19.npubEncode(control.from);
	if (!findContactByNpub(db, npub)) return undefined;
	if (seen.has(control.id, now)) return undefined;
	seen.add(control.id, now);
	return npub;
}

/** Marks each id a receipt names as delivered, when the signer was its recipient and the wrap reached the key that sent it. */
export function applyReceipt(db: PhoneDb, control: ControlRumor, keys: readonly KeyEntry[], now: number): void {
	const key = keys.find((entry) => entry.id === control.keyId);
	if (!key) return;
	const signer = nip19.npubEncode(control.from);
	const to = nip19.npubEncode(key.pub);
	const ids = control.tags.filter((tag) => tag[0] === "e" && typeof tag[1] === "string" && ID_PATTERN.test(tag[1])).slice(0, RECEIPT_IDS_PER_RUMOR);
	const busy = control.tags.some((tag) => tag[0] === BUSY_TAG && tag[1] === "1");
	for (const [, id] of ids) {
		if (busy) db.markBusy(id as string, signer, to, now);
		else db.markDelivered(id as string, signer, to, now);
	}
}

export function replayGuard(): ReturnType<typeof createReplayGuard> {
	return createReplayGuard(SEEN_SECONDS, SEEN_LIMIT);
}

/** Receipts and presence beats for the listener. Every rumor is gift-wrapped and goes out one at a time. */
export function createPresence(deps: PresenceDeps): Presence {
	const seen = replayGuard();
	const pending = new Map<string, { npub: string; busy: boolean; ids: string[] }>();
	const answers = new Map<string, number[]>();
	let stopped = false;
	let flushing: Promise<void> | undefined;
	let beating: Promise<void> | undefined;
	let cursor = 0;

	const send = async (npub: string, kind: number, tags: string[][]) => {
		const contact = findContactByNpub(deps.db, npub);
		const key = contact && deps.keys().find((entry) => entry.id === contact.keyId);
		if (!key) return;
		const rumor = { kind, content: "", tags };
		const event = kind === PRESENCE_KIND ? wrapEphemeral(rumor, key.sk, pubkeyHex(npub)) : wrapTagged(rumor, key.sk, pubkeyHex(npub));
		await publish(deps.pool, contactRelays(deps.db, npub), event, { confirmMs: deps.confirmMs, confirmById: false }).catch(() => undefined);
	};

	const seenAt = (npub: string, at: number) => {
		const now = deps.now();
		const when = Math.min(at, now);
		const before = deps.db.touchLastSeen(npub, when);
		if (when >= now - ONLINE_GAP_SECONDS && (before === null || before < now - ONLINE_GAP_SECONDS)) deps.onOnline(pubkeyHex(npub));
	};

	const flush = async () => {
		while (!stopped) {
			const next = pending.entries().next();
			if (next.done) return;
			const [slot, { npub, busy, ids }] = next.value;
			pending.delete(slot);
			for (let start = 0; start < ids.length && !stopped; start += RECEIPT_IDS_PER_RUMOR) {
				const named = ids.slice(start, start + RECEIPT_IDS_PER_RUMOR).map((id) => ["e", id]);
				await send(npub, RECEIPT_KIND, busy ? [...named, [BUSY_TAG, "1"]] : named);
			}
		}
	};

	const pump = () => {
		if (flushing || stopped) return;
		flushing = Promise.resolve()
			.then(flush)
			.finally(() => {
				flushing = undefined;
				if (pending.size > 0) pump();
			});
	};

	const queueReceipt = (npub: string, id: string, busy = false) => {
		if (!readPresenceOn(deps.db)) return;
		const slot = `${busy ? "busy" : "ok"}:${npub}`;
		const entry = pending.get(slot) ?? { npub, busy, ids: [] };
		if (entry.ids.length >= RECEIPT_BACKLOG || entry.ids.includes(id)) return;
		entry.ids.push(id);
		pending.set(slot, entry);
		pump();
	};

	const answerPing = (npub: string, id: string, now: number) => {
		const recent = (answers.get(npub) ?? []).filter((at) => at > now - PING_WINDOW_SECONDS);
		if (recent.length >= PING_ANSWER_CAP + BUSY_ANSWER_CAP) return;
		answers.set(npub, [...recent, now]);
		queueReceipt(npub, id, recent.length >= PING_ANSWER_CAP);
	};

	return {
		handle(control) {
			if (stopped) return;
			const now = deps.now();
			const npub = acceptControl(deps.db, seen, control, now);
			if (!npub) return;
			seenAt(npub, control.createdAt);
			if (control.kind === RECEIPT_KIND) applyReceipt(deps.db, control, deps.keys(), now);
			else if (control.kind === PRESENCE_KIND && control.tags.some((tag) => tag[0] === ACK_TAG && tag[1] === "1")) answerPing(npub, control.wrapId, now);
		},
		stored(message) {
			if (stopped || !findContactByNpub(deps.db, message.from)) return;
			seenAt(message.from, message.ts);
			queueReceipt(message.from, message.id);
		},
		beat() {
			if (stopped || beating) return beating ?? Promise.resolve();
			if (!readPresenceOn(deps.db)) return Promise.resolve();
			beating = (async () => {
				const contacts = listContacts(deps.db);
				const count = Math.min(PRESENCE_FANOUT, contacts.length);
				for (let index = 0; index < count && !stopped; index += 1) {
					const contact = contacts[(cursor + index) % contacts.length];
					if (contact) await send(contact.npub, PRESENCE_KIND, []);
				}
				cursor = contacts.length ? (cursor + count) % contacts.length : 0;
			})().finally(() => {
				beating = undefined;
			});
			return beating;
		},
		stop() {
			stopped = true;
			pending.clear();
		},
		async settle() {
			while (flushing || beating) await Promise.all([flushing, beating]);
		},
	};
}
