import { existsSync, rmSync } from "node:fs";
import { DgCliError, describeError } from "@dg/common";
import {
	type CredentialClient,
	createCredentialClient,
	credentialGrantTokenPath,
	type DgPaths,
	resolveCliSession,
} from "@dg/common/node";
import { generateSecretKey, nip19 } from "nostr-tools";
import { loadOrCreateKey } from "./store";

export type KeyClient = Pick<CredentialClient, "get" | "set" | "grant" | "close">;
export type KeyStoreMode = "store" | "file";
export type KeyDeps = {
	paths: DgPaths;
	/** A session-authenticated client, or undefined when no daemon or no session is reachable. */
	sessionClient: () => Promise<KeyClient | undefined>;
	grantClient: () => KeyClient;
};
export type LoadedKey = { sk: Uint8Array; mode: KeyStoreMode };

export const KEY_NAME = "phone-friend/nostr-key";
export const GRANT_PREFIX = "phone-friend";

export function defaultKeyClients(paths: DgPaths, session?: string): Omit<KeyDeps, "paths"> {
	return {
		sessionClient: async () => {
			try {
				await resolveCliSession(session, paths);
			} catch {
				return undefined;
			}
			return createCredentialClient({ paths, session });
		},
		grantClient: () => createCredentialClient({ paths, grant: { prefix: GRANT_PREFIX } }),
	};
}

function decodeStored(value: string): Uint8Array {
	try {
		const decoded = nip19.decode(value.trim());
		if (decoded.type === "nsec") return decoded.data;
	} catch {}
	throw new DgCliError(`the credential ${KEY_NAME} does not hold a valid nsec`);
}

async function readStore(deps: KeyDeps): Promise<Uint8Array> {
	const client = deps.grantClient();
	try {
		const record = await client.get(KEY_NAME);
		if (!record) throw new DgCliError(`the dg credential store has no ${KEY_NAME}`);
		return decodeStored(record.value);
	} catch (err) {
		if (err instanceof DgCliError && err.message.includes(KEY_NAME)) throw err;
		throw new DgCliError(
			`your phone-friend key is in the dg credential store, which is not reachable: ${describeError(err)}`,
		);
	} finally {
		client.close();
	}
}

/** Reads the key without making one; store mode never falls back to a new file key. */
export async function loadKey(deps: KeyDeps): Promise<LoadedKey | undefined> {
	if (existsSync(deps.paths.phoneFriendKeyPath)) {
		return { sk: loadOrCreateKey(deps.paths), mode: "file" };
	}
	if (existsSync(credentialGrantTokenPath(deps.paths, GRANT_PREFIX))) {
		return { sk: await readStore(deps), mode: "store" };
	}
	return undefined;
}

async function putInStore(deps: KeyDeps, client: KeyClient, sk: Uint8Array): Promise<boolean> {
	const nsec = nip19.nsecEncode(sk);
	try {
		await client.set(KEY_NAME, nsec, { createdBy: "dg-agent phone-friend" });
		await client.grant(GRANT_PREFIX);
		return Buffer.from(await readStore(deps)).equals(Buffer.from(sk));
	} catch {
		return false;
	}
}

/** Loads the key, makes it on first use, and moves a file key into the store when a session allows. */
export async function ensureKey(deps: KeyDeps): Promise<LoadedKey> {
	const existing = await loadKey(deps);
	if (existing?.mode === "store") return existing;
	const client = await deps.sessionClient();
	try {
		if (existing) {
			if (client && (await putInStore(deps, client, existing.sk))) {
				rmSync(deps.paths.phoneFriendKeyPath, { force: true });
				return { sk: existing.sk, mode: "store" };
			}
			return existing;
		}
		if (client) {
			const sk = generateSecretKey();
			if (await putInStore(deps, client, sk)) return { sk, mode: "store" };
			const winner = await loadKey(deps).catch(() => undefined);
			if (winner) return winner;
		}
		return { sk: loadOrCreateKey(deps.paths), mode: "file" };
	} finally {
		client?.close();
	}
}
