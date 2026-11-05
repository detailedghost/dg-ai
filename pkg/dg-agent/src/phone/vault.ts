import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DgCliError } from "@dg/common";
import { type CredentialClient, createCredentialClient, type DgPaths, ensurePrivateDir, writeFileAtomic } from "@dg/common/node";
import { PHI_TTL_SECONDS, type PhoneDb, VAULT_DIR, type VaultItemRow } from "./db";
import { sniffImage } from "./image";
import { cleanUpOrphan, type KeyClient } from "./keys";

export { VAULT_DIR, type VaultItemRow };

export const VAULT_GRANT_PREFIX = "phone-vault";
export const VAULT_TTL_SECONDS = PHI_TTL_SECONDS;
export const MAX_VAULT_BYTES = 5 * 1024 * 1024;
/** Sender of an item this phone made itself, not one a contact sent. */
export const SELF_SENDER = "self";
/** Names the sender of PHI from a group member who is not a contact. */
export const UNKNOWN_SENDER_HANDLE = "unknown";
/** Stored instead of PHI text that never reaches the vault. */
export const PHI_NOT_STORED_TEXT = "[PHI: not stored]";

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const RECEIVED_NAME_TRIES = 16;

export type VaultClient = Pick<CredentialClient, "get" | "list" | "close">;
export type VaultDeps = {
	/** Reads under the vault grant; undefined when this process has no way to reach the store. */
	vaultClient?: () => VaultClient;
	sessionClient: () => Promise<KeyClient | undefined>;
};
export type DayKey = { day: string; key: Buffer };

export function isVaultName(name: string): boolean {
	return NAME_PATTERN.test(name) && !name.includes("..");
}

export function assertVaultName(name: string): string {
	if (!isVaultName(name)) throw new DgCliError(`vault name "${name}" must match ^[a-z0-9][a-z0-9._-]{0,63}$ with no ..`);
	return name;
}

export function vaultKeyName(day: string): string {
	return `${VAULT_GRANT_PREFIX}/${day}`;
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

/** The local calendar date `offsetDays` after `at` (epoch seconds), as yyyy-mm-dd. */
export function localDay(at: number, offsetDays = 0): string {
	const date = new Date(at * 1000);
	date.setDate(date.getDate() + offsetDays);
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function localMinute(at: number): string {
	const date = new Date(at * 1000);
	return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/** The receiver-made name `<handle>-<yyyymmddhhmm>-<4 hex>`, so no sender text ever names an item. */
export function receivedName(handle: string | undefined, at: number, taken: (name: string) => boolean): string {
	for (let i = 0; i < RECEIVED_NAME_TRIES; i++) {
		const name = `${handle ?? UNKNOWN_SENDER_HANDLE}-${localMinute(at)}-${randomBytes(2).toString("hex")}`;
		if (!taken(name)) return name;
	}
	throw new DgCliError("could not pick a free vault name");
}

export function vaultPlaceholder(name: string, handle?: string): string {
	return handle === undefined ? `[PHI: vault item ${name}]` : `[PHI: vault item ${name} from +${handle}]`;
}

/** Stored for received PHI when no vault key is reachable; the content is dropped, never kept elsewhere. */
export function vaultUnavailableText(handle: string): string {
	return `[PHI: vault unavailable from +${handle}]`;
}

function unreachable(): DgCliError {
	return new DgCliError("the vault needs the dg credential store, which is not reachable; start it with dg-agent start");
}

function decodeKey(day: string, value: string): Buffer {
	if (!/^[0-9a-f]{64}$/.test(value)) throw new DgCliError(`the credential ${vaultKeyName(day)} does not hold a vault key`);
	return Buffer.from(value, "hex");
}

async function withSession<T>(deps: VaultDeps, work: (client: KeyClient) => Promise<T>): Promise<T | undefined> {
	const client = await deps.sessionClient();
	if (!client) return undefined;
	try {
		return await work(client);
	} finally {
		client.close();
	}
}

/** Reads a day key through the grant, else a session; throws when neither reaches the store. */
async function readDayKey(deps: VaultDeps, day: string): Promise<Buffer | undefined> {
	const name = vaultKeyName(day);
	let value: string | undefined;
	try {
		const client = deps.vaultClient?.();
		if (!client) throw unreachable();
		try {
			value = (await client.get(name))?.value;
		} finally {
			client.close();
		}
	} catch {
		const viaSession = await withSession(deps, async (client) => ({ value: (await client.get(name))?.value })).catch(() => undefined);
		if (!viaSession) throw unreachable();
		value = viaSession.value;
	}
	return value === undefined ? undefined : decodeKey(day, value);
}

/** The day's key, made in the store on first use; never falls back to a key outside the store. */
export async function ensureDayKey(deps: VaultDeps, day: string): Promise<Buffer> {
	const existing = await readDayKey(deps, day);
	if (existing) return existing;
	const name = vaultKeyName(day);
	const value = randomBytes(KEY_BYTES).toString("hex");
	const made = await withSession(deps, async (client) => {
		try {
			await client.set(name, value, { createdBy: "dg-agent phone vault" });
			await client.grant(VAULT_GRANT_PREFIX);
			return await readDayKey(deps, day);
		} catch {
			await cleanUpOrphan(client, name, value);
			throw unreachable();
		}
	});
	if (!made) throw new DgCliError(`the vault key for ${day} is not in the dg credential store, and no dg session can make it`);
	return made;
}

/** Deletes every day key whose day is two or more days back; needs a session, so it waits for one. */
export async function dropOldKeys(deps: VaultDeps, now: number): Promise<void> {
	const client = deps.vaultClient?.();
	if (!client) return;
	let names: string[];
	try {
		names = (await client.list()).map((entry) => entry.name);
	} catch {
		return;
	} finally {
		client.close();
	}
	const cutoff = localDay(now, -2);
	const doomed = names.filter((name) => name.startsWith(`${VAULT_GRANT_PREFIX}/`) && name.slice(VAULT_GRANT_PREFIX.length + 1) <= cutoff);
	if (doomed.length === 0) return;
	await withSession(deps, async (session) => {
		for (const name of doomed) await session.delete(name);
	}).catch(() => undefined);
}

/** Throws unless the grant or a session reaches the store. */
export async function requireVaultStore(deps: VaultDeps): Promise<void> {
	try {
		const client = deps.vaultClient?.();
		if (!client) throw unreachable();
		try {
			await client.list();
			return;
		} finally {
			client.close();
		}
	} catch {}
	const ok = await withSession(deps, async (client) => {
		await client.get(vaultKeyName("probe"));
		return true;
	}).catch(() => undefined);
	if (!ok) throw unreachable();
}

export type VaultKeyCache = {
	/** Today's key when it is loaded; a miss starts a refresh. */
	today(): DayKey | undefined;
	current(): Promise<DayKey | undefined>;
	/** Loads or makes today's and tomorrow's keys, then drops old keys. */
	refresh(): Promise<void>;
};

export function createVaultKeyCache(deps: VaultDeps, now: () => number): VaultKeyCache {
	const keys = new Map<string, Buffer>();
	let running: Promise<void> | undefined;
	const refresh = () =>
		(running ??= (async () => {
			for (const offset of [0, 1]) {
				const day = localDay(now(), offset);
				try {
					keys.set(day, await ensureDayKey(deps, day));
				} catch {}
			}
			await dropOldKeys(deps, now());
			const today = localDay(now());
			for (const day of keys.keys()) if (day < today) keys.delete(day);
		})().finally(() => {
			running = undefined;
		}));
	const cached = () => {
		const day = localDay(now());
		const key = keys.get(day);
		return key && { day, key };
	};
	return {
		today() {
			const hit = cached();
			if (!hit) void refresh();
			return hit;
		},
		async current() {
			const hit = cached();
			if (hit) return hit;
			await refresh();
			return cached();
		},
		refresh,
	};
}

function itemAad(row: Pick<VaultItemRow, "id" | "sender" | "expires_at">): Buffer {
	return Buffer.from(`${row.id}\n${row.sender}\n${row.expires_at}`, "utf8");
}

function itemType(plain: Buffer): string {
	const image = sniffImage(plain);
	if (image) return image;
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(plain);
		return "text/plain";
	} catch {
		return "application/octet-stream";
	}
}

function itemPath(root: string, id: string): string {
	return join(root, VAULT_DIR, id);
}

/** Seals `plain` with AES-256-GCM under the day key into `vault/<random id>`, then records the name. */
export function storeVaultItem(
	db: PhoneDb,
	root: string,
	item: { name: string; sender: string; plain: Buffer; key: DayKey },
	now: number,
): VaultItemRow {
	assertVaultName(item.name);
	if (db.vaultNameTaken(item.name)) throw new DgCliError(`vault item ${item.name} exists`);
	const row: VaultItemRow = {
		id: randomBytes(16).toString("hex"),
		name: item.name,
		sender: item.sender,
		type: itemType(item.plain),
		size: item.plain.length,
		key_day: item.key.day,
		created_at: now,
		expires_at: now + VAULT_TTL_SECONDS,
	};
	const nonce = randomBytes(NONCE_BYTES);
	const cipher = createCipheriv("aes-256-gcm", item.key.key, nonce);
	cipher.setAAD(itemAad(row));
	const sealed = Buffer.concat([nonce, cipher.update(item.plain), cipher.final(), cipher.getAuthTag()]);
	ensurePrivateDir(join(root, VAULT_DIR));
	const path = itemPath(root, row.id);
	writeFileAtomic(path, sealed, 0o600);
	if (!db.addVaultItem(row)) {
		rmSync(path, { force: true });
		throw new DgCliError(`vault item ${item.name} exists`);
	}
	return row;
}

/** Decrypts an item in memory; throws when its key, file, or bound fields no longer match. */
export async function openVaultItem(deps: VaultDeps, root: string, row: VaultItemRow): Promise<Buffer> {
	const failed = () => new DgCliError(`vault item ${row.name} cannot be opened`);
	const key = await readDayKey(deps, row.key_day).catch((err: unknown) => {
		throw err instanceof DgCliError && err.message.includes("not reachable") ? err : failed();
	});
	if (!key) throw failed();
	try {
		const sealed = readFileSync(itemPath(root, row.id));
		const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, NONCE_BYTES));
		decipher.setAAD(itemAad(row));
		decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
		return Buffer.concat([decipher.update(sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES)), decipher.final()]);
	} catch {
		throw failed();
	}
}

/** Seals PHI a contact sent under a receiver-made name; returns the row text that stands in for it. */
export function sealReceived(
	db: PhoneDb,
	root: string,
	item: { key: DayKey; sender: string; handle: string; plain: Buffer },
	now: number,
): { row: VaultItemRow; text: string } {
	const name = receivedName(item.handle, now, (candidate) => db.vaultNameTaken(candidate));
	const row = storeVaultItem(db, root, { name, sender: item.sender, plain: item.plain, key: item.key }, now);
	return { row, text: vaultPlaceholder(name, item.handle) };
}

export function deleteVaultItem(db: PhoneDb, root: string, row: Pick<VaultItemRow, "id">): void {
	db.removeVaultItem(row.id);
	rmSync(itemPath(root, row.id), { force: true });
}

export function defaultVaultClient(paths: DgPaths): () => VaultClient {
	return () => createCredentialClient({ paths, grant: { prefix: VAULT_GRANT_PREFIX } });
}
