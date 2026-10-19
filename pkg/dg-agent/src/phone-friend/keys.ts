import { DgCliError, describeError } from "@dg/common";
import {
	type CredentialClient,
	createCredentialClient,
	type DgPaths,
	resolveCliSession,
} from "@dg/common/node";
import { generateSecretKey, nip19 } from "nostr-tools";
import type { LinePaths } from "./line";
import { createFileKey, isKeyInStore, markKeyInStore, readFileKey } from "./store";

export type KeyClient = Pick<CredentialClient, "get" | "set" | "grant" | "close">;
export type KeyStoreMode = "store" | "file";
export type KeyDeps = {
	paths: DgPaths;
	line: LinePaths;
	/** A session-authenticated client, or undefined when no daemon or no session is reachable. */
	sessionClient: () => Promise<KeyClient | undefined>;
	grantClient: () => KeyClient;
};
export type LoadedKey = { sk: Uint8Array; mode: KeyStoreMode };

/** Credential-store name for a line's key. */
export function keyName(line: LinePaths): string {
	return `phone-friend/${line.name}/nostr-key`;
}
export const GRANT_PREFIX = "phone-friend";

export function defaultKeyClients(
	paths: DgPaths,
	session?: string,
): Omit<KeyDeps, "paths" | "line"> {
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

function decodeStored(name: string, value: string): Uint8Array {
	try {
		const decoded = nip19.decode(value.trim());
		if (decoded.type === "nsec") return decoded.data;
	} catch {}
	throw new DgCliError(`the credential ${name} does not hold a valid nsec`);
}

async function readStore(deps: KeyDeps): Promise<Uint8Array> {
	const name = keyName(deps.line);
	const client = deps.grantClient();
	try {
		const record = await client.get(name);
		if (!record) throw new DgCliError(`the dg credential store has no ${name}`);
		return decodeStored(name, record.value);
	} catch (err) {
		if (err instanceof DgCliError && err.message.includes(name)) throw err;
		throw new DgCliError(
			`your phone-friend key is in the dg credential store, which is not reachable: ${describeError(err)}`,
		);
	} finally {
		client.close();
	}
}

/** Reads the key without making one; store mode never falls back to a new file key. */
export async function loadKey(deps: KeyDeps): Promise<LoadedKey | undefined> {
	const fileKey = readFileKey(deps.line);
	if (fileKey) return { sk: fileKey, mode: "file" };
	if (isKeyInStore(deps.line)) return { sk: await readStore(deps), mode: "store" };
	return undefined;
}

async function putInStore(deps: KeyDeps, client: KeyClient, sk: Uint8Array): Promise<boolean> {
	const nsec = nip19.nsecEncode(sk);
	try {
		await client.set(keyName(deps.line), nsec, { createdBy: "dg-agent phone-friend" });
		await client.grant(GRANT_PREFIX);
		if (!Buffer.from(await readStore(deps)).equals(Buffer.from(sk))) return false;
		return markKeyInStore(deps.line, sk);
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
				return { sk: existing.sk, mode: "store" };
			}
			return existing;
		}
		if (client) {
			const sk = generateSecretKey();
			if (await putInStore(deps, client, sk)) return { sk, mode: "store" };
		}
		const created = createFileKey(deps.line);
		if (created) return { sk: created, mode: "file" };
		return { sk: await readStore(deps), mode: "store" };
	} finally {
		client?.close();
	}
}
