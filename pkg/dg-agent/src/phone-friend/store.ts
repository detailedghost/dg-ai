import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { DgCliError } from "@dg/common";
import { type DgPaths, ensurePrivateDir, writeFileAtomic } from "@dg/common/node";
import { generateSecretKey, nip19 } from "nostr-tools";
import type { Invite, Message } from "./chat";

export type PhoneFriendConfig = { contact?: string; relays: string[] };
export type Seen = { cursor: number; ids: string[] };

export const DEFAULT_RELAYS = [
	"wss://relay.damus.io",
	"wss://nos.lol",
	"wss://relay.primal.net",
];
/** Caps the persisted seen-id list so the file does not grow forever. */
export const SEEN_ID_LIMIT = 2000;

function readJson<T>(path: string, fallback: T): T {
	if (!existsSync(path)) return fallback;
	return { ...fallback, ...JSON.parse(readFileSync(path, "utf8")) };
}

/** Creates the 0600 nsec file on first call and reuses it after; throws if it holds anything else. */
export function loadOrCreateKey(paths: DgPaths): Uint8Array {
	ensurePrivateDir(paths.phoneFriendDir);
	if (existsSync(paths.phoneFriendKeyPath)) {
		try {
			const decoded = nip19.decode(readFileSync(paths.phoneFriendKeyPath, "utf8").trim());
			if (decoded.type === "nsec") return decoded.data;
		} catch {}
		throw new DgCliError(`${paths.phoneFriendKeyPath} does not hold a valid nsec`);
	}
	const sk = generateSecretKey();
	writeFileAtomic(paths.phoneFriendKeyPath, `${nip19.nsecEncode(sk)}\n`, 0o600);
	return sk;
}

export function readConfig(paths: DgPaths): PhoneFriendConfig {
	return readJson<PhoneFriendConfig>(paths.phoneFriendConfigPath, { relays: DEFAULT_RELAYS });
}

export function writeConfig(paths: DgPaths, config: PhoneFriendConfig): void {
	ensurePrivateDir(paths.phoneFriendDir);
	writeFileAtomic(paths.phoneFriendConfigPath, `${JSON.stringify(config, null, 2)}\n`, 0o600);
}

export function readSeen(paths: DgPaths): Seen {
	return readJson<Seen>(paths.phoneFriendSeenPath, { cursor: 0, ids: [] });
}

export function remember(seen: Seen, ids: string[]): Seen {
	return { cursor: seen.cursor, ids: [...seen.ids, ...ids].slice(-SEEN_ID_LIMIT) };
}

export function writeSeen(paths: DgPaths, seen: Seen): void {
	ensurePrivateDir(paths.phoneFriendDir);
	writeFileAtomic(paths.phoneFriendSeenPath, JSON.stringify(remember(seen, [])), 0o600);
}

export function appendInbox(paths: DgPaths, message: Message): void {
	ensurePrivateDir(paths.phoneFriendDir);
	appendFileSync(paths.phoneFriendInboxPath, `${JSON.stringify(message)}\n`, { mode: 0o600 });
}

export function readInvite(paths: DgPaths): Invite | undefined {
	if (!existsSync(paths.phoneFriendInvitePath)) return undefined;
	const { secret, expires_at } = JSON.parse(readFileSync(paths.phoneFriendInvitePath, "utf8"));
	return typeof secret === "string" && typeof expires_at === "number"
		? { secret, expiresAt: expires_at }
		: undefined;
}

export function writeInvite(paths: DgPaths, invite: Invite): void {
	ensurePrivateDir(paths.phoneFriendDir);
	writeFileAtomic(
		paths.phoneFriendInvitePath,
		JSON.stringify({ secret: invite.secret, expires_at: invite.expiresAt }),
		0o600,
	);
}

export function clearInvite(paths: DgPaths): void {
	rmSync(paths.phoneFriendInvitePath, { force: true });
}
