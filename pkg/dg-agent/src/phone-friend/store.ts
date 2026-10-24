import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { DgCliError } from "@dg/common";
import { type DgPaths, ensurePrivateDir, realSubdirectories, writeFileAtomic } from "@dg/common/node";
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

/** Leading dot keeps this outside the line-name charset, so it can never collide with a line directory of the same name. */
const WHOAMI_FILE = ".whoami";
const FALLBACK_SELF_NAME = "dg";

function whoamiPath(paths: DgPaths): string {
	return join(paths.phoneFriendRoot, WHOAMI_FILE);
}

/** The saved self name, shared across every line; undefined when never set. */
export function readWhoami(paths: DgPaths): string | undefined {
	const path = whoamiPath(paths);
	if (!existsSync(path)) return undefined;
	return readFileSync(path, "utf8").trim() || undefined;
}

export function writeWhoami(paths: DgPaths, name: string): void {
	if (!isLineName(name)) {
		throw new DgCliError(`a self name must be 1-32 lowercase letters, digits, or dashes, got "${name}"`);
	}
	ensurePrivateDir(paths.phoneFriendRoot);
	writeFileAtomic(whoamiPath(paths), `${name}\n`, 0o600);
}

/** Lowercases and strips to the line-name charset; undefined when nothing usable survives. */
export function sanitizeSelfName(raw: string): string | undefined {
	const cleaned = raw
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "")
		.slice(0, 32)
		.replace(/^-+|-+$/g, "");
	return isLineName(cleaned) ? cleaned : undefined;
}

function osUsername(): string {
	try {
		return userInfo().username;
	} catch {
		return process.env.USER ?? process.env.USERNAME ?? "";
	}
}

/** The self name to use when none is saved: the OS username, sanitized, or "dg" when that yields nothing. */
export function defaultSelfName(raw: string = osUsername()): string {
	return sanitizeSelfName(raw) ?? FALLBACK_SELF_NAME;
}

/** The self name a new card carries: the saved `whoami`, else the OS-username default. */
export function resolvedSelfName(paths: DgPaths): string {
	return readWhoami(paths) ?? defaultSelfName();
}

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

/** The @ handle this line's owner uses to refer to it: the contact name if set, else the line name. */
export function handleFor(config: PhoneFriendConfig, line: LinePaths): string {
	return `@${config.name ?? line.name}`;
}

/** Every line that holds a database, in name order. */
export function listLines(paths: DgPaths): LinePaths[] {
	return realSubdirectories(paths.phoneFriendRoot)
		.filter(isLineName)
		.sort()
		.map((name) => linePaths(paths, name))
		.filter((line) => existsSync(line.dbPath));
}

/** Resolves --line from a line name, a saved contact name, or a contact npub, each with an optional leading @; an unknown name is a new line. */
export function resolveLine(paths: DgPaths, value: string): LinePaths {
	const name = value.startsWith("@") ? value.slice(1) : value;
	const lines = listLines(paths);
	if (lines.some((line) => line.name === name)) return linePaths(paths, name);
	const matches = lines.filter((line) => {
		const config = readConfig(line);
		return config.name === name || config.contact === name;
	});
	if (matches.length > 1) {
		throw new DgCliError(`"${value}" matches lines ${matches.map((line) => line.name).join(", ")}; pick one with --line`);
	}
	if (matches[0]) return matches[0];
	if (name.startsWith("npub1")) throw new DgCliError(`no line has contact ${value}`);
	return linePaths(paths, name);
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

/** The other line, if any, that already holds this name by its line name or its saved contact name. */
export function lineClaiming(paths: DgPaths, line: LinePaths, name: string): LinePaths | undefined {
	return listLines(paths).find(
		(other) => other.name !== line.name && (other.name === name || readConfig(other).name === name),
	);
}

/**
 * The line to dial into for a v2 card's handle, with no explicit `--line` or `--name`: the line
 * of that name, brand new or already paired with this same contact. A same-named line that exists
 * but is not confirmed as this contact (no contact yet, or a different one) is left alone instead
 * of guessed at, since a wrong guess would silently drop that line's own contact. Also refuses a
 * name another line already claims by its own saved contact name.
 */
export function lineForHandle(paths: DgPaths, handle: string, npub: string): LinePaths {
	const derived = linePaths(paths, handle);
	const claimedBy = lineClaiming(paths, derived, handle);
	if (claimedBy) {
		throw new DgCliError(`"${handle}" is already used by line ${claimedBy.name}; dial again with --line to pick one`);
	}
	if (existsSync(derived.dbPath) && readConfig(derived).contact !== npub) {
		throw new DgCliError(`line "${handle}" already has a different contact; dial again with --line to pick one`);
	}
	return derived;
}

/** Deletes the invite and saves the caller as the contact, with the invite's name, in one transaction. */
export function acceptCall(paths: DgPaths, line: LinePaths, contact: string): void {
	withDb(line, (db) =>
		db.transaction(() => {
			const invited = db.get<Invite>(INVITE)?.name;
			const name = invited && !lineClaiming(paths, line, invited) ? invited : undefined;
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
