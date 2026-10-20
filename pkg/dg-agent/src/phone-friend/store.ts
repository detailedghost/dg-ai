import { DgCliError } from "@dg/common";
import { generateSecretKey, nip19 } from "nostr-tools";
import type { Invite } from "./chat";
import { PhoneFriendDb } from "./db";
import type { LinePaths } from "./line";

export type PhoneFriendConfig = { contact?: string; relays: string[] };

export const DEFAULT_RELAYS = [
	"wss://relay.damus.io",
	"wss://nos.lol",
	"wss://relay.primal.net",
];

const CONFIG = "config";
const INVITE = "invite";
const FILE_KEY = "nsec";
const KEY_IN_STORE = "key_in_store";
const STARTING = "listener_starting";
/** A start claim older than this belongs to a command that died while starting the listener. */
export const START_CLAIM_SECONDS = 30;

export function withDb<T>(line: LinePaths, work: (db: PhoneFriendDb) => T): T {
	const db = PhoneFriendDb.open(line);
	try {
		return work(db);
	} finally {
		db.close();
	}
}

function decodeFileKey(line: LinePaths, value: unknown): Uint8Array {
	try {
		if (typeof value === "string") {
			const decoded = nip19.decode(value);
			if (decoded.type === "nsec") return decoded.data;
		}
	} catch {}
	throw new DgCliError(`${line.dbPath} does not hold a valid nsec for line ${line.name}`);
}

export function readFileKey(line: LinePaths): Uint8Array | undefined {
	const stored = withDb(line, (db) => db.get<string>(FILE_KEY));
	return stored === undefined ? undefined : decodeFileKey(line, stored);
}

/** Makes the file-mode key once, unless the key already lives in the store; a racing writer gets the first key. */
export function createFileKey(line: LinePaths): Uint8Array | undefined {
	const stored = withDb(line, (db) =>
		db.transaction(() =>
			db.get<boolean>(KEY_IN_STORE) ? undefined : db.setOnce(FILE_KEY, nip19.nsecEncode(generateSecretKey())),
		),
	);
	return stored === undefined ? undefined : decodeFileKey(line, stored);
}

/** Marks the key as moved to the store and drops the file copy; refuses when a different file key exists. */
export function markKeyInStore(line: LinePaths, sk: Uint8Array): boolean {
	const nsec = nip19.nsecEncode(sk);
	return withDb(line, (db) =>
		db.transaction(() => {
			const fileKey = db.get<string>(FILE_KEY);
			if (fileKey !== undefined && fileKey !== nsec) return false;
			db.set(KEY_IN_STORE, true);
			db.unset(FILE_KEY);
			return true;
		}),
	);
}

export function isKeyInStore(line: LinePaths): boolean {
	return withDb(line, (db) => db.get<boolean>(KEY_IN_STORE) === true);
}

export function readConfig(line: LinePaths): PhoneFriendConfig {
	const saved = withDb(line, (db) => db.get<PhoneFriendConfig>(CONFIG));
	return { relays: DEFAULT_RELAYS, ...saved };
}

export function writeConfig(line: LinePaths, config: PhoneFriendConfig): void {
	withDb(line, (db) => db.set(CONFIG, config));
}

export function readInvite(line: LinePaths): Invite | undefined {
	return withDb(line, (db) => db.get<Invite>(INVITE));
}

/** Saves the invite and the relays its card names in one transaction. */
export function writeInvite(line: LinePaths, invite: Invite, relays: string[]): void {
	withDb(line, (db) =>
		db.transaction(() => {
			db.set(CONFIG, { ...db.get<PhoneFriendConfig>(CONFIG), relays });
			db.set(INVITE, invite);
		}),
	);
}

export function clearInvite(line: LinePaths): void {
	withDb(line, (db) => db.unset(INVITE));
}

/** Claims the right to start this line's listener, so two commands cannot each spawn one. */
export function claimStart(line: LinePaths, now: number): boolean {
	return withDb(line, (db) =>
		db.transaction(() => {
			const held = db.get<number>(STARTING);
			if (held !== undefined && held > now - START_CLAIM_SECONDS) return false;
			db.set(STARTING, now);
			return true;
		}),
	);
}

export function releaseStart(line: LinePaths): void {
	withDb(line, (db) => db.unset(STARTING));
}

/** Deletes the invite and saves the caller as the contact in one transaction. */
export function acceptCall(line: LinePaths, contact: string): void {
	withDb(line, (db) =>
		db.transaction(() => {
			db.unset(INVITE);
			db.set(CONFIG, { relays: DEFAULT_RELAYS, ...db.get<PhoneFriendConfig>(CONFIG), contact });
		}),
	);
}
