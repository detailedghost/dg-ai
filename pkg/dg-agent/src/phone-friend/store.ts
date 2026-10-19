import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DgCliError } from "@dg/common";
import { type DgPaths, ensurePrivateDir, writeFileAtomic } from "@dg/common/node";
import { generateSecretKey, nip19 } from "nostr-tools";
import type { Invite } from "./chat";

export type PhoneFriendConfig = { contact?: string; relays: string[] };

export const DEFAULT_RELAYS = [
	"wss://relay.damus.io",
	"wss://nos.lol",
	"wss://relay.primal.net",
];

function readJson<T>(path: string, fallback: T): T {
	if (!existsSync(path)) return fallback;
	return { ...fallback, ...JSON.parse(readFileSync(path, "utf8")) };
}

/** Creates the 0600 nsec file once (exclusive create, so a racing writer reads the winner) and reuses it after. */
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
	try {
		writeFileSync(paths.phoneFriendKeyPath, `${nip19.nsecEncode(sk)}\n`, { mode: 0o600, flag: "wx" });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST") return loadOrCreateKey(paths);
		throw err;
	}
	return sk;
}

export function readConfig(paths: DgPaths): PhoneFriendConfig {
	return readJson<PhoneFriendConfig>(paths.phoneFriendConfigPath, { relays: DEFAULT_RELAYS });
}

export function writeConfig(paths: DgPaths, config: PhoneFriendConfig): void {
	ensurePrivateDir(paths.phoneFriendDir);
	writeFileAtomic(paths.phoneFriendConfigPath, `${JSON.stringify(config, null, 2)}\n`, 0o600);
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
