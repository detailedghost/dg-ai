import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { DgCliError } from "@dg/common";
import { type DgPaths, ensurePrivateDir, writeFileAtomic } from "@dg/common/node";
import { generateSecretKey, nip19 } from "nostr-tools";
import type { Message } from "./chat";

export type PhoneConfig = { peer?: string; relays: string[] };
export type Seen = { cursor: number; ids: string[] };

export const DEFAULT_RELAYS = [
	"wss://relay.damus.io",
	"wss://nos.lol",
	"wss://relay.primal.net",
];
export const SEEN_ID_LIMIT = 2000;

function readJson<T>(path: string, fallback: T): T {
	if (!existsSync(path)) return fallback;
	return { ...fallback, ...JSON.parse(readFileSync(path, "utf8")) };
}

export function loadOrCreateKey(paths: DgPaths): Uint8Array {
	ensurePrivateDir(paths.phoneDir);
	if (existsSync(paths.phoneKeyPath)) {
		try {
			const decoded = nip19.decode(readFileSync(paths.phoneKeyPath, "utf8").trim());
			if (decoded.type === "nsec") return decoded.data;
		} catch {}
		throw new DgCliError(`${paths.phoneKeyPath} does not hold a valid nsec`);
	}
	const sk = generateSecretKey();
	writeFileAtomic(paths.phoneKeyPath, `${nip19.nsecEncode(sk)}\n`, 0o600);
	return sk;
}

export function readConfig(paths: DgPaths): PhoneConfig {
	return readJson<PhoneConfig>(paths.phoneConfigPath, { relays: DEFAULT_RELAYS });
}

export function writeConfig(paths: DgPaths, config: PhoneConfig): void {
	ensurePrivateDir(paths.phoneDir);
	writeFileAtomic(paths.phoneConfigPath, `${JSON.stringify(config, null, 2)}\n`, 0o600);
}

export function readSeen(paths: DgPaths): Seen {
	return readJson<Seen>(paths.phoneSeenPath, { cursor: 0, ids: [] });
}

export function remember(seen: Seen, ids: string[]): Seen {
	return { cursor: seen.cursor, ids: [...seen.ids, ...ids].slice(-SEEN_ID_LIMIT) };
}

export function writeSeen(paths: DgPaths, seen: Seen): void {
	ensurePrivateDir(paths.phoneDir);
	writeFileAtomic(paths.phoneSeenPath, JSON.stringify(remember(seen, [])), 0o600);
}

export function appendInbox(paths: DgPaths, message: Message): void {
	ensurePrivateDir(paths.phoneDir);
	appendFileSync(paths.phoneInboxPath, `${JSON.stringify(message)}\n`, { mode: 0o600 });
}
