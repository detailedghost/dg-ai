import { randomBytes } from "node:crypto";
import { DgCliError } from "@dg/common";
import { nip19 } from "nostr-tools";
import type { AutostartState } from "./autostart";
import type { Gate } from "./chat";
import { PHONE_SYSTEM_SENDER, type ContactRow, type InviteRow, type PhoneDb } from "./db";

export type NumberRecord = { secret: string; as: string; rotatedAt?: number };
export type ContactRecord = { npub: string; handle: string; relays: string[]; keyId: string; addedAt: number; via: string };
export type InviteRecord = { secret: string; expiresAt: number; asName: string; name?: string; keyId: string; relays: string[] };
export type OnMessageConfig = { argv: string[]; timeoutMs: number };
/** The `--on-message` hook `open` installed and the autostart manager it last reported, so a bare
 * `open` or a service manager's own restart picks up the same hook without the flag repeated. */
export type ListenerConfig = { onMessage?: OnMessageConfig; autostart?: AutostartState };

export const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"];
export const FALLBACK_SELF_NAME = "dg";
/** The key id a fresh install's own identity gets; a migrated phone may point `number_key` elsewhere. */
export const DEFAULT_NUMBER_KEY_ID = "default";

const HANDLE_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const NUMBER_SETTING = "number";
const RELAYS_SETTING = "relays";
const NUMBER_KEY_SETTING = "number_key";
const LISTENER_SETTING = "listener";
const DRIFT_SETTING = "listener_drift";
/** Bumped when who may ring changes, so a running listener can reload without a restart. */
const ADMISSION_EPOCH = "admission_epoch";
/** Same setting name phone-friend's per-line db used for its relay-subscription resume point. */
const CURSOR_SETTING = "cursor";
/** Milliseconds `say` and `accept` wait for a relay OK. The env var overrides this. */
export const PUBLISH_CONFIRM_SETTING = "publish_confirm_ms";
/** Short-lived kind 10050 lookup results, keyed by recipient pubkey hex. */
const INBOX_RELAYS_SETTING = "inbox_relays";

export type InboxRelayCacheEntry = { relays: string[]; at: number };

export function isHandle(value: string): boolean {
	return HANDLE_PATTERN.test(value);
}

/** Contact handles share the command namespace with threads, and threads own the `#` prefix. */
export function assertContactHandle(handle: string): void {
	if (handle.startsWith("#")) {
		throw new DgCliError(`a contact handle cannot start with "#", got "${handle}"`);
	}
}

/** Strips a leading `+`, the only prefix the new commands accept on a handle argument. */
export function normalizeHandle(value: string): string {
	return value.startsWith("+") ? value.slice(1) : value;
}

export function readNumber(db: PhoneDb): NumberRecord | undefined {
	return db.get<NumberRecord>(NUMBER_SETTING);
}

export function readAdmissionEpoch(db: PhoneDb): number {
	return db.get<number>(ADMISSION_EPOCH) ?? 0;
}

export function bumpAdmissionEpoch(db: PhoneDb): number {
	const next = readAdmissionEpoch(db) + 1;
	db.set(ADMISSION_EPOCH, next);
	return next;
}

export function writeNumber(db: PhoneDb, record: NumberRecord): void {
	const previous = readNumber(db);
	db.set(NUMBER_SETTING, record);
	if (previous?.secret !== record.secret) bumpAdmissionEpoch(db);
}

export function resolvedSelfName(db: PhoneDb): string {
	return readNumber(db)?.as ?? FALLBACK_SELF_NAME;
}

export function readRelays(db: PhoneDb): string[] {
	return db.get<string[]>(RELAYS_SETTING) ?? DEFAULT_RELAYS;
}

export function writeRelays(db: PhoneDb, relays: string[]): void {
	const previous = readRelays(db);
	db.set(RELAYS_SETTING, relays);
	if (previous.length !== relays.length || previous.some((relay, index) => relay !== relays[index])) bumpAdmissionEpoch(db);
}

/** Relays the listener must read: the saved number relays, plus every live invite's and contact's own list. */
export function subscriptionRelays(db: PhoneDb): string[] {
	const relays = new Set(readRelays(db));
	for (const invite of liveInvites(db)) {
		for (const relay of invite.relays) relays.add(relay);
	}
	for (const contact of listContacts(db)) {
		for (const relay of contact.relays) relays.add(relay);
	}
	return [...relays];
}

/** The key id your own number uses; `setOnce` so a racing first command wins and a migration can set it first. */
export function numberKeyId(db: PhoneDb): string {
	return db.get<string>(NUMBER_KEY_SETTING) ?? db.setOnce(NUMBER_KEY_SETTING, DEFAULT_NUMBER_KEY_ID);
}

/** Overwrites the number key id outright; migration uses this to point it at the line it picked
 * before any command's lazy `setOnce` default could win the race. */
export function writeNumberKeyId(db: PhoneDb, id: string): void {
	db.set(NUMBER_KEY_SETTING, id);
}

/** The relay-subscription resume point; 0 means nothing has been read yet. */
export function readCursor(db: PhoneDb): number {
	return db.get<number>(CURSOR_SETTING) ?? 0;
}

export function writeCursor(db: PhoneDb, cursor: number): void {
	db.set(CURSOR_SETTING, cursor);
}

/** The saved OK-wait, in milliseconds, when a command has stored one. Absent means use the default. */
export function readPublishConfirmSetting(db: PhoneDb): number | undefined {
	const value = db.get<unknown>(PUBLISH_CONFIRM_SETTING);
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Cached kind 10050 relays for `pubkey`, or undefined when missing or older than `ttlSeconds`. */
export function readInboxRelayCache(db: PhoneDb, pubkey: string, now: number, ttlSeconds: number): string[] | undefined {
	const cache = db.get<Record<string, InboxRelayCacheEntry>>(INBOX_RELAYS_SETTING);
	const entry = cache?.[pubkey];
	if (!entry || !Array.isArray(entry.relays)) return undefined;
	if (now - entry.at >= ttlSeconds) return undefined;
	return entry.relays.filter((relay): relay is string => typeof relay === "string");
}

export function writeInboxRelayCache(db: PhoneDb, pubkey: string, relays: string[], now: number): void {
	const cache = db.get<Record<string, InboxRelayCacheEntry>>(INBOX_RELAYS_SETTING) ?? {};
	cache[pubkey] = { relays, at: now };
	db.set(INBOX_RELAYS_SETTING, cache);
}

function toContactRecord(row: ContactRow): ContactRecord {
	return {
		npub: row.npub,
		handle: row.handle,
		relays: JSON.parse(row.relays) as string[],
		keyId: row.key_id,
		addedAt: row.added_at,
		via: row.via,
	};
}

export function listContacts(db: PhoneDb): ContactRecord[] {
	return db.listContacts().map(toContactRecord);
}

export function findContactByHandle(db: PhoneDb, handle: string): ContactRecord | undefined {
	const row = db.getContactByHandle(handle);
	return row ? toContactRecord(row) : undefined;
}

export function findContactByNpub(db: PhoneDb, npub: string): ContactRecord | undefined {
	const row = db.getContactByNpub(npub);
	return row ? toContactRecord(row) : undefined;
}

export function requireFreeHandle(db: PhoneDb, handle: string): void {
	assertContactHandle(handle);
	if (!isHandle(handle)) {
		throw new DgCliError(`a handle must be 1-32 lowercase letters, digits, or dashes, got "${handle}"`);
	}
	const taken = db.getContactByHandle(handle);
	if (taken) throw new DgCliError(`"${handle}" is already used by +${taken.handle}`);
}

/** `base`, else `base-2`, `base-3`, ... until one is free. */
export function nextFreeHandle(db: PhoneDb, base: string): string {
	if (!db.getContactByHandle(base)) return base;
	for (let suffix = 2; ; suffix += 1) {
		const candidate = `${base}-${suffix}`;
		if (!db.getContactByHandle(candidate)) return candidate;
	}
}

export function addContact(db: PhoneDb, record: ContactRecord): void {
	db.putContact({
		npub: record.npub,
		handle: record.handle,
		relays: JSON.stringify(record.relays),
		key_id: record.keyId,
		added_at: record.addedAt,
		via: record.via,
	});
}

export function insertNewContact(db: PhoneDb, record: ContactRecord): boolean {
	return db.insertContact({
		npub: record.npub,
		handle: record.handle,
		relays: JSON.stringify(record.relays),
		key_id: record.keyId,
		added_at: record.addedAt,
		via: record.via,
	});
}

export function renameContact(db: PhoneDb, handle: string, newHandle: string): ContactRecord {
	const existing = db.getContactByHandle(handle);
	if (!existing) throw new DgCliError(`no contact +${handle}`);
	requireFreeHandle(db, newHandle);
	db.putContact({ ...existing, handle: newHandle });
	return toContactRecord({ ...existing, handle: newHandle });
}

export function removeContact(db: PhoneDb, handle: string): ContactRecord {
	const existing = db.getContactByHandle(handle);
	if (!existing) throw new DgCliError(`no contact +${handle}`);
	db.removeContact(existing.npub);
	bumpAdmissionEpoch(db);
	return toContactRecord(existing);
}

/** Moves a contact to the key the listener saw it ring on; the "re-accept" a known caller's ring triggers. */
export function setContactKeyId(db: PhoneDb, npub: string, keyId: string): void {
	db.setContactKeyId(npub, keyId);
}

function toInviteRecord(row: InviteRow): InviteRecord {
	let relays: string[] = [];
	if (row.relays) {
		try {
			const parsed = JSON.parse(row.relays) as unknown;
			if (Array.isArray(parsed)) relays = parsed.filter((relay): relay is string => typeof relay === "string");
		} catch {}
	}
	return {
		secret: row.secret,
		expiresAt: row.expires_at,
		asName: row.as_name,
		name: row.name ?? undefined,
		keyId: row.key_id,
		relays,
	};
}

export function liveInvites(db: PhoneDb): InviteRecord[] {
	return db.listLiveInvites().map(toInviteRecord);
}

export function addInvite(db: PhoneDb, record: Omit<InviteRecord, "relays"> & { relays?: string[] }): void {
	db.putInvite({
		secret: record.secret,
		expires_at: record.expiresAt,
		as_name: record.asName,
		name: record.name ?? null,
		key_id: record.keyId,
		relays: JSON.stringify(record.relays ?? []),
	});
	bumpAdmissionEpoch(db);
}

export function consumeInvite(db: PhoneDb, secret: string): boolean {
	const consumed = db.consumeInvite(secret);
	if (consumed) bumpAdmissionEpoch(db);
	return consumed;
}

export function readListener(db: PhoneDb): ListenerConfig | undefined {
	return db.get<ListenerConfig>(LISTENER_SETTING);
}

export function writeListener(db: PhoneDb, record: ListenerConfig): void {
	db.set(LISTENER_SETTING, record);
}

export function clearListener(db: PhoneDb): void {
	db.unset(LISTENER_SETTING);
}

/** A local inbox row. `sender` is `phone`, so it is not delivered to a contact or to `--on-message`. */
export function addPhoneNotice(db: PhoneDb, text: string, now: number): void {
	db.addMessage({
		id: `phone-notice-${now}-${randomBytes(4).toString("hex")}`,
		direction: "in",
		ts: now,
		sender: PHONE_SYSTEM_SENDER,
		contact: PHONE_SYSTEM_SENDER,
		text,
		call: 0,
	});
}

/** Records `text` once per `token`, so a repeated status check does not pile up the same notice. */
export function notePhoneDrift(db: PhoneDb, token: string, text: string, now: number): void {
	if (db.get<string>(DRIFT_SETTING) === token) return;
	db.set(DRIFT_SETTING, token);
	addPhoneNotice(db, text, now);
}

/** The newest unread local notice, or null when voicemail has none waiting. */
export function latestPhoneNotice(db: PhoneDb): string | null {
	const rows = db.unreadMessages().filter((row) => row.sender === PHONE_SYSTEM_SENDER);
	return rows.at(-1)?.text ?? null;
}

/** Decodes an npub to its hex pubkey, or a clean `DgCliError` for anything that is not one. */
export function pubkeyHex(npub: string): string {
	try {
		const decoded = nip19.decode(npub);
		if (decoded.type === "npub") return decoded.data;
	} catch {}
	throw new DgCliError(`contact must be an npub, got "${npub}"`);
}

/** Builds the live admission gate from the current contacts, number secret, and unexpired invites. */
export function gateFor(db: PhoneDb): Gate {
	const contacts = new Map<string, { npub: string; handle: string; keyId: string }>();
	for (const row of db.listContacts()) {
		contacts.set(pubkeyHex(row.npub), { npub: row.npub, handle: row.handle, keyId: row.key_id });
	}
	return {
		contacts,
		secrets: {
			number: readNumber(db)?.secret ?? "",
			invites: liveInvites(db).map((invite) => ({
				secret: invite.secret,
				expiresAt: invite.expiresAt,
				name: invite.name,
				relays: invite.relays,
			})),
		},
	};
}
