import { DgCliError, describeError } from "@dg/common";
import { type CredentialClient, createCredentialClient, type DgPaths, resolveCliSession } from "@dg/common/node";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import type { KeyEntry } from "./chat";
import type { PhoneDb } from "./db";
import { numberKeyId } from "./store";

export type KeyClient = Pick<CredentialClient, "get" | "set" | "grant" | "close" | "delete">;
export type KeyStoreMode = "store" | "file";
export type KeyDeps = {
	paths: DgPaths;
	db: PhoneDb;
	/** A session-authenticated client, or undefined when no daemon or no session is reachable. */
	sessionClient: () => Promise<KeyClient | undefined>;
	grantClient: () => KeyClient;
};
export type LoadedKey = { sk: Uint8Array; mode: KeyStoreMode };

/** Credential-store name for a key row. Kept identical to phone-friend's line-keyed name: an
 * internal identifier, not user-facing, so the migration writes nothing to the store. */
export function keyName(id: string): string {
	return `phone-friend/${id}/nostr-key`;
}
export const GRANT_PREFIX = "phone-friend";

export function defaultKeyClients(paths: DgPaths, session?: string): Omit<KeyDeps, "paths" | "db"> {
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

function decodeStored(id: string, value: string): Uint8Array {
	try {
		const decoded = nip19.decode(value.trim());
		if (decoded.type === "nsec") return decoded.data;
	} catch {}
	throw new DgCliError(`the credential ${keyName(id)} does not hold a valid nsec`);
}

function decodeFileKey(id: string, value: string): Uint8Array {
	try {
		const decoded = nip19.decode(value);
		if (decoded.type === "nsec") return decoded.data;
	} catch {}
	throw new DgCliError(`the phone database does not hold a valid nsec for key "${id}"`);
}

async function readStore(deps: KeyDeps, id: string): Promise<Uint8Array> {
	const name = keyName(id);
	const client = deps.grantClient();
	try {
		const record = await client.get(name);
		if (!record) throw new DgCliError(`the dg credential store has no ${name}`);
		return decodeStored(id, record.value);
	} catch (err) {
		if (err instanceof DgCliError && err.message.includes(name)) throw err;
		throw new DgCliError(`your phone key is in the dg credential store, which is not reachable: ${describeError(err)}`);
	} finally {
		client.close();
	}
}

export function readFileKey(db: PhoneDb, id: string): Uint8Array | undefined {
	const row = db.getKey(id);
	if (!row || row.nsec === null) return undefined;
	return decodeFileKey(id, row.nsec);
}

export function isKeyInStore(db: PhoneDb, id: string): boolean {
	return db.getKey(id)?.in_store === 1;
}

/** Makes the file-mode key once, unless the key already lives in the store; a racing writer gets the first key. */
export function createFileKey(db: PhoneDb, id: string): Uint8Array | undefined {
	const row = db.ensureKeyRow(id, () => ({ nsec: nip19.nsecEncode(generateSecretKey()), in_store: 0 }));
	if (row.in_store) return undefined;
	return row.nsec === null ? undefined : decodeFileKey(id, row.nsec);
}

/** Marks the key as moved to the store and drops the file copy; refuses when a different file key exists. */
export function markKeyInStore(db: PhoneDb, id: string, sk: Uint8Array): boolean {
	const nsec = nip19.nsecEncode(sk);
	return db.transaction(() => {
		const existing = db.getKey(id);
		if (existing && existing.nsec !== null && existing.nsec !== nsec) return false;
		db.putKey({ id, nsec: null, in_store: 1 });
		return true;
	});
}

/** Reads the key without making one; store mode never falls back to a new file key. */
export async function loadKey(deps: KeyDeps, id: string): Promise<LoadedKey | undefined> {
	const fileKey = readFileKey(deps.db, id);
	if (fileKey) return { sk: fileKey, mode: "file" };
	if (isKeyInStore(deps.db, id)) return { sk: await readStore(deps, id), mode: "store" };
	return undefined;
}

/** Best-effort: deletes `name` only if it still holds the value this call itself wrote. */
export async function cleanUpOrphan(client: KeyClient, name: string, ownValue: string): Promise<void> {
	try {
		const record = await client.get(name);
		if (record?.value === ownValue) await client.delete(name);
	} catch {}
}

/** Only a thrown error below is cleaned up; a plain read-back mismatch means another run's key
 * already won the race and is the live credential now, not an orphan of this call's. */
async function putInStore(deps: KeyDeps, id: string, client: KeyClient, sk: Uint8Array): Promise<boolean> {
	const name = keyName(id);
	const nsec = nip19.nsecEncode(sk);
	try {
		await client.set(name, nsec, { createdBy: "dg-agent phone" });
		await client.grant(GRANT_PREFIX);
		if (!Buffer.from(await readStore(deps, id)).equals(Buffer.from(sk))) return false;
		return markKeyInStore(deps.db, id, sk);
	} catch (err) {
		await cleanUpOrphan(client, name, nsec);
		process.stderr.write(
			`phone: the dg credential store did not take the key, so it stays in the phone database: ${describeError(err)}\n`,
		);
		return false;
	}
}

/** Loads the key, makes it on first use, and moves a file key into the store when a session allows. */
export async function ensureKey(deps: KeyDeps, id: string): Promise<LoadedKey> {
	const existing = await loadKey(deps, id);
	if (existing?.mode === "store") return existing;
	const client = await deps.sessionClient();
	try {
		if (existing) {
			if (client && (await putInStore(deps, id, client, existing.sk))) return { sk: existing.sk, mode: "store" };
			return existing;
		}
		if (client) {
			const sk = generateSecretKey();
			if (await putInStore(deps, id, client, sk)) return { sk, mode: "store" };
		}
		const created = createFileKey(deps.db, id);
		if (created) return { sk: created, mode: "file" };
		return { sk: await readStore(deps, id), mode: "store" };
	} finally {
		client?.close();
	}
}

/** Loads or creates the one key your own number uses, keyed by `settings.number_key`. */
export function ensureNumberKey(deps: KeyDeps): Promise<LoadedKey> {
	return ensureKey(deps, numberKeyId(deps.db));
}

export type LoadedKeys = { keys: KeyEntry[]; unreadable: string[] };

/** Every key row the database knows. `unreadable` lists rows whose store read failed; those are not a key change. */
export async function loadAllKeys(deps: KeyDeps): Promise<LoadedKeys> {
	const keys: KeyEntry[] = [];
	const unreadable: string[] = [];
	for (const id of deps.db.listKeyIds()) {
		try {
			const loaded = await loadKey(deps, id);
			if (loaded) keys.push({ id, pub: getPublicKey(loaded.sk), sk: loaded.sk });
		} catch {
			unreadable.push(id);
		}
	}
	return { keys, unreadable };
}
