import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DgCliError } from "@dg/common";
import { type CredentialClient, createCredentialClient, type DgPaths, ensurePrivateDir, writeFileAtomic } from "@dg/common/node";
import { PHI_TTL_SECONDS, type PhoneDb, VAULT_DIR, type VaultItemRow } from "./db";
import { withFileLock, withFileLockSync } from "./file-lock";
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
/** Bytes a sealed vault file adds to its plaintext: the nonce and the GCM tag. */
export const SEALED_OVERHEAD_BYTES = NONCE_BYTES + TAG_BYTES;
const RECEIVED_NAME_TRIES = 16;
const KEY_LOCK_FILE = "vault-key.lock";
const WRITE_LOCK_FILE = "vault-write.lock";

export type VaultClient = Pick<CredentialClient, "get" | "list" | "close">;
export type VaultDeps = {
	/** Reads under the vault grant; undefined when this process has no way to reach the store. */
	vaultClient?: () => VaultClient;
	sessionClient: () => Promise<KeyClient | undefined>;
};
/** Adds the phone root, where the key lock lives, for code that may make a period key. */
export type VaultKeyDeps = VaultDeps & { paths: Pick<DgPaths, "phoneRoot"> };
export type PeriodKey = { period: string; key: Buffer };

export function isVaultName(name: string): boolean {
	return NAME_PATTERN.test(name.toLowerCase()) && !name.includes("..");
}

/** Accepts either letter case and returns the lowercase form that is stored and looked up. */
export function assertVaultName(name: string): string {
	if (!isVaultName(name)) throw new DgCliError(`vault name "${name}" must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ with no ..`);
	return name.toLowerCase();
}

export function vaultKeyName(period: string): string {
	return `${VAULT_GRANT_PREFIX}/${period.toLowerCase()}`;
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

const PERIOD_DAYS = 7;
const KEY_GRACE_SECONDS = 48 * 60 * 60;
const PERIOD_PATTERN = /^(\d{4})-[Ww](\d{2})$/;

function isoWeekMonday(at: Date): Date {
	const monday = new Date(at.getFullYear(), at.getMonth(), at.getDate());
	monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
	return monday;
}

/** The ISO 8601 week, by local time, that holds `at` (epoch seconds) moved by `offset` whole weeks, as yyyy-wnn. */
export function keyPeriod(at: number, offset = 0): string {
	const date = new Date(at * 1000);
	date.setDate(date.getDate() + offset * PERIOD_DAYS);
	const thursday = isoWeekMonday(date);
	thursday.setDate(thursday.getDate() + 3);
	const year = thursday.getFullYear();
	const dayOfYear = Math.round((thursday.getTime() - new Date(year, 0, 1).getTime()) / 86_400_000);
	const week = Math.floor(dayOfYear / PERIOD_DAYS) + 1;
	return `${year}-w${pad(week)}`;
}

/** Epoch seconds when the period ends, the next Monday 00:00 local; undefined when `period` is not `yyyy-wnn` or `yyyy-Wnn`. */
export function keyPeriodEnd(period: string): number | undefined {
	const match = PERIOD_PATTERN.exec(period);
	if (!match) return undefined;
	const year = Number(match[1]);
	const week = Number(match[2]);
	const monday = isoWeekMonday(new Date(year, 0, 4));
	monday.setDate(monday.getDate() + week * PERIOD_DAYS);
	return monday.getTime() / 1000;
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

/** Stored for received PHI over the per-item cap or when receive storage is full; the content is dropped. */
export function vaultStorageFullText(handle: string): string {
	return `[PHI: storage full from +${handle}]`;
}

function unreachable(): DgCliError {
	return new DgCliError("the vault needs the dg credential store, which is not reachable; start it with dg-agent start");
}

/** A failure to reach the daemon, not a rejection of a request the daemon could answer. */
function storeDown(err: unknown): boolean {
	return err instanceof Error && /not reachable|dg-daemon is not running|no live dg-daemon pid file|cannot connect to dg-daemon|timed out connecting to dg-daemon/.test(err.message);
}

function grantMiss(err: unknown): boolean {
	return err instanceof Error && err.message.includes("no credential grant");
}

type SessionOutcome<T> = { ok: true; value: T } | { ok: false; error?: unknown; down?: boolean };

/** Runs `work` on a session. `down` is a connection failure; `error` is a rejection from a store that answered. */
async function sessionWork<T>(deps: VaultDeps, work: (client: KeyClient) => Promise<T>): Promise<SessionOutcome<T>> {
	let client: KeyClient | undefined;
	try {
		client = await deps.sessionClient();
	} catch (error) {
		return storeDown(error) ? { ok: false, down: true } : { ok: false, error };
	}
	if (!client) return { ok: false };
	try {
		return { ok: true, value: await work(client) };
	} catch (error) {
		return storeDown(error) ? { ok: false, down: true } : { ok: false, error };
	} finally {
		client.close();
	}
}

function decodeKey(period: string, value: string): Buffer {
	if (!/^[0-9a-f]{64}$/.test(value)) throw new DgCliError(`the credential ${vaultKeyName(period)} does not hold a vault key`);
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

/** Reads a period key through the grant, else a session. A rejection is rethrown; only a missed connection becomes unreachable. */
async function readPeriodKey(deps: VaultDeps, period: string): Promise<Buffer | undefined> {
	const name = vaultKeyName(period);
	let value: string | undefined;
	try {
		const client = deps.vaultClient?.();
		if (!client) throw unreachable();
		try {
			value = (await client.get(name))?.value;
		} finally {
			client.close();
		}
	} catch (err) {
		const via = await sessionWork(deps, async (client) => (await client.get(name))?.value);
		if (via.ok) value = via.value;
		else if (via.error) throw via.error;
		else if (!storeDown(err) && !grantMiss(err)) throw err;
		else throw unreachable();
	}
	return value === undefined ? undefined : decodeKey(period, value);
}

/** Runs a cap check and the write after it under one cross-process lock, so two writers cannot both pass the check. */
export function withVaultWriteLock<T>(root: string, work: () => T): T {
	return withFileLockSync(root, WRITE_LOCK_FILE, "another dg process is writing receive storage; try again", work);
}

/** The period's key, made in the store on first use under the key lock; returns the stored key, never one outside the store. */
export async function ensurePeriodKey(deps: VaultKeyDeps, period: string): Promise<Buffer> {
	const existing = await readPeriodKey(deps, period);
	if (existing) return existing;
	return withFileLock(deps.paths.phoneRoot, KEY_LOCK_FILE, "another dg process is making the vault key; try again", () => makePeriodKey(deps, period));
}

async function makePeriodKey(deps: VaultKeyDeps, period: string): Promise<Buffer> {
	const stored = await readPeriodKey(deps, period);
	if (stored) return stored;
	const name = vaultKeyName(period);
	const value = randomBytes(KEY_BYTES).toString("hex");
	const made = await sessionWork(deps, async (client) => {
		try {
			await client.set(name, value, { createdBy: "dg-agent phone vault" });
			await client.grant(VAULT_GRANT_PREFIX);
			return await readPeriodKey(deps, period);
		} catch (err) {
			await cleanUpOrphan(client, name, value);
			throw err;
		}
	});
	if (!made.ok) {
		if (made.error) throw made.error;
		if (made.down) throw unreachable();
		throw new DgCliError(`the vault key for ${period} is not in the dg credential store, and no dg session can make it`);
	}
	if (!made.value) throw new DgCliError(`the vault key for ${period} is not in the dg credential store, and no dg session can make it`);
	return made.value;
}

/** Deletes every period key whose period ended 48 hours ago or more; needs a session, so it waits for one. */
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
	const doomed = names.filter((name) => {
		if (!name.toLowerCase().startsWith(`${VAULT_GRANT_PREFIX}/`)) return false;
		const end = keyPeriodEnd(name.slice(VAULT_GRANT_PREFIX.length + 1));
		return end !== undefined && end + KEY_GRACE_SECONDS <= now;
	});
	if (doomed.length === 0) return;
	await withSession(deps, async (session) => {
		for (const name of doomed) await session.delete(name);
	}).catch(() => undefined);
}

/** Throws unless the grant or a session reaches the store. A rejection from a live store is reported as itself. */
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
	} catch (err) {
		const via = await sessionWork(deps, async (client) => {
			await client.get(vaultKeyName("probe"));
			return true;
		});
		if (via.ok) return;
		if (via.error) throw via.error;
		if (!storeDown(err) && !grantMiss(err)) throw err;
		throw unreachable();
	}
}

export type VaultKeyCache = {
	/** This period's key when it is loaded; a miss starts a refresh. */
	peek(): PeriodKey | undefined;
	current(): Promise<PeriodKey | undefined>;
	/** Loads or makes this period's and the next period's keys, then drops old keys. */
	refresh(): Promise<void>;
};

export function createVaultKeyCache(deps: VaultKeyDeps, now: () => number): VaultKeyCache {
	const keys = new Map<string, Buffer>();
	let running: Promise<void> | undefined;
	const refresh = () =>
		(running ??= (async () => {
			for (const offset of [0, 1]) {
				const period = keyPeriod(now(), offset);
				try {
					keys.set(period, await ensurePeriodKey(deps, period));
				} catch {}
			}
			await dropOldKeys(deps, now());
			const current = keyPeriod(now());
			for (const period of keys.keys()) if (period < current) keys.delete(period);
		})().finally(() => {
			running = undefined;
		}));
	const cached = () => {
		const period = keyPeriod(now());
		const key = keys.get(period);
		return key && { period, key };
	};
	return {
		peek() {
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

/** Seals `plain` with AES-256-GCM under the period key into `vault/<random id>`, then records the name. */
export function storeVaultItem(
	db: PhoneDb,
	root: string,
	item: { name: string; sender: string; plain: Buffer; key: PeriodKey; ext?: string | null },
	now: number,
): VaultItemRow {
	const name = assertVaultName(item.name);
	if (db.vaultNameTaken(name)) throw new DgCliError(`vault item ${name} exists`);
	const row: VaultItemRow = {
		id: randomBytes(16).toString("hex"),
		name,
		sender: item.sender,
		type: itemType(item.plain),
		size: item.plain.length,
		key_period: item.key.period,
		created_at: now,
		expires_at: now + VAULT_TTL_SECONDS,
		ext: item.ext ?? null,
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
		throw new DgCliError(`vault item ${name} exists`);
	}
	return row;
}

/** Decrypts an item in memory; throws when its key, file, or bound fields no longer match. */
export async function openVaultItem(deps: VaultDeps, root: string, row: VaultItemRow): Promise<Buffer> {
	const failed = () => new DgCliError(`vault item ${row.name} cannot be opened`);
	const key = await readPeriodKey(deps, row.key_period).catch((err: unknown) => {
		if (err instanceof DgCliError && err.message.includes("does not hold a vault key")) throw failed();
		if (err instanceof DgCliError || err instanceof TypeError) throw err;
		throw failed();
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
	item: { key: PeriodKey; sender: string; handle: string; plain: Buffer; ext?: string | null },
	now: number,
): { row: VaultItemRow; text: string } {
	const name = receivedName(item.handle, now, (candidate) => db.vaultNameTaken(candidate));
	const row = storeVaultItem(db, root, { name, sender: item.sender, plain: item.plain, key: item.key, ext: item.ext }, now);
	return { row, text: vaultPlaceholder(name, item.handle) };
}

export function deleteVaultItem(db: PhoneDb, root: string, row: Pick<VaultItemRow, "id">): void {
	db.removeVaultItem(row.id);
	rmSync(itemPath(root, row.id), { force: true });
}

export function defaultVaultClient(paths: DgPaths): () => VaultClient {
	return () => createCredentialClient({ paths, grant: { prefix: VAULT_GRANT_PREFIX } });
}
