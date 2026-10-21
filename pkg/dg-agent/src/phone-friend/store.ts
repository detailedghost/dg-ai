import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { DgCliError } from "@dg/common";
import { type DgPaths, realSubdirectories } from "@dg/common/node";
import { generateSecretKey, nip19 } from "nostr-tools";
import type { Invite } from "./chat";
import { PhoneFriendDb } from "./db";
import { isLineName, type LinePaths, linePaths } from "./line";

export type PhoneFriendConfig = { contact?: string; name?: string; relays: string[] };

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

/** Every line that holds a database, in name order. */
export function listLines(paths: DgPaths): LinePaths[] {
	return realSubdirectories(paths.phoneFriendRoot)
		.filter(isLineName)
		.sort()
		.map((name) => linePaths(paths, name))
		.filter((line) => existsSync(line.dbPath));
}

/** Resolves --line from a line name, a saved contact name, or a contact npub; an unknown name is a new line. */
export function resolveLine(paths: DgPaths, value: string): LinePaths {
	const lines = listLines(paths);
	if (lines.some((line) => line.name === value)) return linePaths(paths, value);
	const matches = lines.filter((line) => {
		const config = readConfig(line);
		return config.name === value || config.contact === value;
	});
	if (matches.length > 1) {
		throw new DgCliError(`"${value}" matches lines ${matches.map((line) => line.name).join(", ")}; pick one with --line`);
	}
	if (matches[0]) return matches[0];
	if (value.startsWith("npub1")) throw new DgCliError(`no line has contact ${value}`);
	return linePaths(paths, value);
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

type StartClaim = { at: number; token: string };

/** Claims the right to start this line's listener; returns the claim token, or undefined while another command holds it. */
export function claimStart(line: LinePaths, now: number): string | undefined {
	return withDb(line, (db) =>
		db.transaction(() => {
			const held = db.get<StartClaim>(STARTING);
			if (held && held.at > now - START_CLAIM_SECONDS) return undefined;
			const token = randomUUID();
			db.set(STARTING, { at: now, token });
			return token;
		}),
	);
}

/** Drops the claim only if it is still ours, so a stale holder cannot clear a newer claim. */
export function releaseStart(line: LinePaths, token: string): void {
	withDb(line, (db) =>
		db.transaction(() => {
			if (db.get<StartClaim>(STARTING)?.token === token) db.unset(STARTING);
		}),
	);
}

/** Deletes the invite and saves the caller as the contact, with the invite's name, in one transaction. */
export function acceptCall(line: LinePaths, contact: string): void {
	withDb(line, (db) =>
		db.transaction(() => {
			const name = db.get<Invite>(INVITE)?.name;
			db.unset(INVITE);
			db.set(CONFIG, {
				relays: DEFAULT_RELAYS,
				...db.get<PhoneFriendConfig>(CONFIG),
				contact,
				...(name ? { name } : {}),
			});
		}),
	);
}
