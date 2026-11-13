import { Database } from "bun:sqlite";
import { chmodSync, lstatSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import {
	applyConnectionPragmas,
	type DgPaths,
	ensurePrivateDir,
	type MigrationStep,
	runMigrations,
} from "@dg/common/node";
import { join } from "node:path";
import { assertNotBlocked } from "@dg/common/node/layout";
import { FILE_NAME_PATTERN, FILES_DIR, imageFileName, parseImageFile } from "./image";
import { migrateThreadSchema } from "./thread-schema";

export type Direction = "in" | "out";

/** Local voicemail rows. Never a contact, and never handed to `--on-message`. */
export const PHONE_SYSTEM_SENDER = "phone";

export type MessageRow = {
	id: string;
	direction: Direction;
	ts: number;
	sender: string;
	contact: string;
	text: string;
	call: number;
	read_at: number | null;
	attempts: number;
	thread_id: string | null;
	/** JSON `{sha256, type, size}` for an image row, else null. */
	file: string | null;
	/** 1 when the sender marked the message as PHI. */
	phi: number;
	/** This phone's clock when the row was stored; PHI expiry uses it, never the sender's `ts`. */
	received_at: number;
	/** When a recipient's receipt for an outgoing row arrived, else null. */
	delivered_at: number | null;
	/** The agent on this machine the row belongs to; null is the shared inbox. */
	ext: string | null;
	/** The agent on the other machine: the sender's `dg-from-ext`, or the extension we sent to. */
	peer_ext: string | null;
};

/** Which rows a reader sees: null is the shared inbox only, a name is that agent plus the shared inbox. */
export type ExtView = { ext: string | null };

/** One extension a contact's messages named as their sender. */
export type ContactExtRow = { ext: string; last_seen: number };

/** Extensions kept per contact; a peer that claims more loses its oldest. */
const CONTACT_EXT_LIMIT = 16;

/** One image still being fetched; the row, with its key and nonce, is deleted when the fetch ends. */
export type ImageFetchRow = {
	message_id: string;
	sender: string;
	key_id: string;
	x: string;
	ox: string;
	size: number;
	key: string;
	nonce: string;
	attempts: number;
	next_at: number;
	deadline: number;
};

export type KeyRow = { id: string; nsec: string | null; in_store: number; created_at: number };

export type ContactRow = {
	npub: string;
	handle: string;
	relays: string;
	key_id: string;
	added_at: number;
	via: string;
	/** Latest rumor time seen from this contact, else null. */
	last_seen: number | null;
	/** The paired machine this contact was imported from, else null. */
	origin_npub: string | null;
	/** Runtime label from a roster entry, else null. */
	runtime: string | null;
};

export type ContactWrite = Omit<ContactRow, "last_seen" | "origin_npub" | "runtime"> & {
	origin_npub?: string | null;
	runtime?: string | null;
};

export type IdentityRow = { handle: string; key_id: string; runtime: string };

/** One `phone ping` check: `sender` is our npub that signed it, `contact` the npub it went to. */
export type PingRow = { id: string; contact: string; sender: string; sent_at: number; delivered_at: number | null; busy_at: number | null };

export type ThreadRow = {
	id: string;
	handle: string;
	subject: string;
	key_id: string;
	created_at: number;
	via: string;
};

export type PendingThreadRow = {
	rumor_id: string;
	room_id: string;
	sender: string;
	members: string;
	subject: string | null;
	text: string;
	ts: number;
	noticed: number;
	received_at: number;
	/** 1 when the sender marked the message as PHI. */
	phi: number;
};

export type InviteRow = {
	secret: string;
	expires_at: number;
	as_name: string;
	name: string | null;
	key_id: string;
	/** JSON array of relay URLs this invite's card was published on. Absent on a row written before that column existed. */
	relays?: string;
};

/** Messages older than this are deleted, same horizon the old phone-friend lines used. */
export const MESSAGE_TTL_SECONDS = 7 * 24 * 60 * 60;

/** NIP-59 backdates each wrap's `created_at` by up to two days, so `since` must reach that far behind the cursor. */
export const LOOKBACK_SECONDS = 2 * 24 * 60 * 60;

/** PHI rows, their outbox copies, and outbox files with no row live this long instead of the message TTL. */
export const PHI_TTL_SECONDS = 24 * 60 * 60;

/** Folder under `phoneRoot` that holds staged ciphertext, one file per `x` hash. */
export const OUTBOX_DIR = "outbox";

/** Folder under `phoneRoot` that holds sealed vault items, one file per random item id. */
export const VAULT_DIR = "vault";
const VAULT_ID_PATTERN = /^[0-9a-f]{32}$/;
const VAULT_VIEW_PATTERN = /^[0-9a-f]{32}\.view\.(?:png|jpg|webp)$/;
/** A human's viewer copy of a vault image is removed by prune after this, if `vault open` did not remove it. */
const VAULT_VIEW_GRACE_SECONDS = 60 * 60;

/** One sealed PHI item; `sender` and `expires_at` are bound into the AES-GCM tag with `id`. */
export type VaultItemRow = {
	id: string;
	name: string;
	sender: string;
	type: string;
	size: number;
	key_period: string;
	created_at: number;
	expires_at: number;
	/** The agent on this machine the item came in for; null is shared. */
	ext: string | null;
};

/** A receipt that beat its row to the database is held this long. */
const EARLY_RECEIPT_SECONDS = 10 * 60;
/** Held early receipts; the oldest are dropped past this. */
const EARLY_RECEIPT_LIMIT = 256;

/** A crashed atomic write older than this is removed by prune. */
const TMP_GRACE_SECONDS = 60;

const SCHEMA: MigrationStep[] = [
	{
		version: 1,
		run: (db) => {
			db.run(`CREATE TABLE keys (
				id TEXT PRIMARY KEY,
				nsec TEXT,
				in_store INTEGER NOT NULL DEFAULT 0,
				created_at INTEGER NOT NULL
			) STRICT`);
			db.run(`CREATE TABLE contacts (
				npub TEXT PRIMARY KEY,
				handle TEXT NOT NULL UNIQUE,
				relays TEXT NOT NULL,
				key_id TEXT NOT NULL REFERENCES keys(id),
				added_at INTEGER NOT NULL,
				via TEXT NOT NULL
			) STRICT`);
			db.run(`CREATE TABLE invites (
				secret TEXT PRIMARY KEY,
				expires_at INTEGER NOT NULL,
				as_name TEXT NOT NULL,
				name TEXT,
				key_id TEXT NOT NULL REFERENCES keys(id)
			) STRICT`);
			db.run(`CREATE TABLE messages (
				id TEXT PRIMARY KEY,
				direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
				ts INTEGER NOT NULL,
				sender TEXT NOT NULL,
				contact TEXT NOT NULL,
				text TEXT NOT NULL,
				call INTEGER NOT NULL DEFAULT 0,
				read_at INTEGER,
				attempts INTEGER NOT NULL DEFAULT 0
			) STRICT`);
			db.run("CREATE INDEX idx_messages_ts ON messages(ts)");
			db.run(
				"CREATE INDEX idx_messages_unread ON messages(ts) WHERE direction = 'in' AND read_at IS NULL",
			);
			db.run("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT");
		},
	},
	{
		version: 2,
		run: (db) => {
			db.run("ALTER TABLE invites ADD COLUMN relays TEXT NOT NULL DEFAULT '[]'");
		},
	},
	{
		version: 3,
		run: (db) => {
			migrateThreadSchema(db);
		},
	},
	{
		version: 4,
		run: (db) => {
			migrateThreadSchema(db);
		},
	},
	{
		version: 5,
		run: (db) => {
			db.run("ALTER TABLE messages ADD COLUMN file TEXT");
			db.run("ALTER TABLE messages ADD COLUMN phi INTEGER NOT NULL DEFAULT 0");
			db.run(`CREATE TABLE outbox (
				sha256 TEXT PRIMARY KEY,
				key_id TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				phi INTEGER NOT NULL DEFAULT 0
			) STRICT`);
			db.run(`CREATE TABLE outbox_recipients (
				sha256 TEXT NOT NULL REFERENCES outbox(sha256) ON DELETE CASCADE,
				pubkey TEXT NOT NULL,
				PRIMARY KEY (sha256, pubkey)
			) STRICT`);
		},
	},
	{
		version: 6,
		run: (db) => {
			db.run("ALTER TABLE messages ADD COLUMN received_at INTEGER NOT NULL DEFAULT 0");
			db.run("UPDATE messages SET received_at = ts");
			db.run(`CREATE TABLE image_fetches (
				message_id TEXT PRIMARY KEY,
				sender TEXT NOT NULL,
				key_id TEXT NOT NULL,
				x TEXT NOT NULL,
				ox TEXT NOT NULL,
				size INTEGER NOT NULL,
				key TEXT NOT NULL,
				nonce TEXT NOT NULL,
				attempts INTEGER NOT NULL DEFAULT 0,
				next_at INTEGER NOT NULL,
				deadline INTEGER NOT NULL
			) STRICT`);
			db.run("ALTER TABLE pending_threads ADD COLUMN phi INTEGER NOT NULL DEFAULT 0");
			db.run(`CREATE TABLE expired_ids (
				id TEXT PRIMARY KEY,
				expires_at INTEGER NOT NULL
			) STRICT`);
		},
	},
	{
		version: 7,
		run: (db) => {
			db.run("ALTER TABLE messages ADD COLUMN delivered_at INTEGER");
			db.run("ALTER TABLE contacts ADD COLUMN last_seen INTEGER");
			db.run(`CREATE TABLE pings (
				id TEXT PRIMARY KEY,
				contact TEXT NOT NULL,
				sender TEXT NOT NULL,
				sent_at INTEGER NOT NULL,
				delivered_at INTEGER,
				busy_at INTEGER
			) STRICT`);
			db.run(`CREATE TABLE early_receipts (
				id TEXT NOT NULL,
				signer TEXT NOT NULL,
				recipient TEXT NOT NULL,
				at INTEGER NOT NULL,
				PRIMARY KEY (id, signer)
			) STRICT`);
		},
	},
	{
		version: 8,
		run: (db) => {
			db.run(`CREATE TABLE vault_items (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL UNIQUE,
				sender TEXT NOT NULL,
				type TEXT NOT NULL,
				size INTEGER NOT NULL,
				key_period TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				expires_at INTEGER NOT NULL
			) STRICT`);
		},
	},
	{
		version: 9,
		run: (db) => {
			db.run("ALTER TABLE messages ADD COLUMN ext TEXT");
			db.run("ALTER TABLE messages ADD COLUMN peer_ext TEXT");
			db.run("ALTER TABLE vault_items ADD COLUMN ext TEXT");
			db.run(`CREATE TABLE ext_reads (
				message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
				ext TEXT NOT NULL,
				read_at INTEGER NOT NULL,
				PRIMARY KEY (message_id, ext)
			) STRICT`);
			db.run(`CREATE TABLE contact_exts (
				npub TEXT NOT NULL REFERENCES contacts(npub) ON DELETE CASCADE,
				ext TEXT NOT NULL,
				last_seen INTEGER NOT NULL,
				PRIMARY KEY (npub, ext)
			) STRICT`);
		},
	},
	{
		version: 10,
		run: (db) => {
			db.run("ALTER TABLE contacts ADD COLUMN origin_npub TEXT");
			db.run("ALTER TABLE contacts ADD COLUMN runtime TEXT");
			db.run(`CREATE TABLE identities (
				handle TEXT PRIMARY KEY,
				key_id TEXT NOT NULL,
				runtime TEXT NOT NULL
			) STRICT`);
			db.run(`CREATE TABLE roster_sent (
				npub TEXT PRIMARY KEY,
				hash TEXT NOT NULL,
				at INTEGER NOT NULL
			) STRICT`);
			db.run(`CREATE TABLE roster_held (
				npub TEXT PRIMARY KEY,
				body TEXT NOT NULL,
				intent TEXT NOT NULL,
				at INTEGER NOT NULL
			) STRICT`);
		},
	},
];

/** One SQLite file for every key, contact, invite, and message, shared across the whole phone. */
export class PhoneDb {
	private constructor(
		private readonly db: Database,
		private readonly now: () => number,
		private readonly dir: string,
	) {}

	static path(paths: DgPaths): string {
		return join(paths.phoneRoot, "phone.db");
	}

	static open(paths: DgPaths, now: () => number = () => Math.floor(Date.now() / 1000)): PhoneDb {
		assertNotBlocked(paths, "phone");
		return PhoneDb.openAt(PhoneDb.path(paths), paths.phoneRoot, now);
	}

	/** Opens (or creates) a database at an arbitrary path inside `dir`; migration builds
	 * `phone.db.tmp` here and renames it into place once every row is written. */
	static openAt(
		dbPath: string,
		dir: string,
		now: () => number = () => Math.floor(Date.now() / 1000),
	): PhoneDb {
		ensurePrivateDir(dir);
		writeFileSync(dbPath, "", { mode: 0o600, flag: "a" });
		chmodSync(dbPath, 0o600);
		const db = new Database(dbPath, { strict: true, create: true, readwrite: true });
		try {
			applyConnectionPragmas(db);
			db.run("PRAGMA secure_delete = ON");
			runMigrations(db, SCHEMA);
		} catch (err) {
			db.close(true);
			throw err;
		}
		const opened = new PhoneDb(db, now, dir);
		opened.pruneMessages();
		return opened;
	}

	private cutoff(): number {
		return this.now() - MESSAGE_TTL_SECONDS;
	}

	pruneMessages(): void {
		const cutoff = this.cutoff();
		const phiCutoff = this.now() - PHI_TTL_SECONDS;
		const pendingBefore = this.listPending().length;
		const expired = "ts < $cutoff OR (phi = 1 AND received_at < $phiCutoff)";
		const doomed = this.fileNames(`SELECT file FROM messages WHERE file IS NOT NULL AND direction = 'in' AND (${expired})`, { cutoff, phiCutoff });
		const now = this.now();
		const tombstoneUntil = now + MESSAGE_TTL_SECONDS + LOOKBACK_SECONDS;
		this.db.query("DELETE FROM expired_ids WHERE expires_at <= $now").run({ now });
		this.db
			.query("INSERT OR IGNORE INTO expired_ids (id, expires_at) SELECT id, $until FROM messages WHERE phi = 1 AND received_at < $phiCutoff")
			.run({ until: tombstoneUntil, phiCutoff });
		this.db
			.query("INSERT OR IGNORE INTO expired_ids (id, expires_at) SELECT rumor_id, $until FROM pending_threads WHERE phi = 1 AND received_at < $phiCutoff")
			.run({ until: tombstoneUntil, phiCutoff });
		this.db.query(`DELETE FROM messages WHERE ${expired}`).run({ cutoff, phiCutoff });
		this.db.query("DELETE FROM image_fetches WHERE message_id NOT IN (SELECT id FROM messages)").run();
		this.db.query("DELETE FROM pings WHERE sent_at < $cutoff").run({ cutoff });
		this.db.query("DELETE FROM early_receipts WHERE at < $early").run({ early: now - EARLY_RECEIPT_SECONDS });
		this.db.query("DELETE FROM pending_threads WHERE received_at < $cutoff OR (phi = 1 AND received_at < $phiCutoff)").run({ cutoff, phiCutoff });
		if (this.listPending().length !== pendingBefore) this.syncHeldNotice();
		this.pruneOutbox(cutoff, phiCutoff);
		this.pruneFiles(doomed, phiCutoff);
		this.pruneVault(now);
	}

	/** Drops expired items and their files, then stray files and old viewer copies; never follows a symlink. */
	private pruneVault(now: number): void {
		const folder = join(this.dir, VAULT_DIR);
		const expired = this.db.query("SELECT id FROM vault_items WHERE expires_at <= $now").all({ now }) as { id: string }[];
		for (const { id } of expired) {
			this.removeVaultItem(id);
			rmSync(join(folder, id), { force: true });
		}
		let names: string[];
		try {
			names = readdirSync(folder);
		} catch {
			return;
		}
		const known = this.db.query("SELECT 1 FROM vault_items WHERE id = $id");
		for (const name of names) {
			const path = join(folder, name);
			const stat = lstatSync(path, { throwIfNoEntry: false });
			if (!stat?.isFile()) continue;
			const age = now - stat.mtimeMs / 1000;
			const stale = VAULT_VIEW_PATTERN.test(name)
				? age > VAULT_VIEW_GRACE_SECONDS
				: age > TMP_GRACE_SECONDS && !(VAULT_ID_PATTERN.test(name) && known.get({ id: name }) !== null);
			if (stale) rmSync(path, { force: true });
		}
	}

	/** False when the name is taken. */
	addVaultItem(row: VaultItemRow): boolean {
		const result = this.db
			.query(
				`INSERT OR IGNORE INTO vault_items (id, name, sender, type, size, key_period, created_at, expires_at, ext)
				VALUES ($id, $name, $sender, $type, $size, $keyPeriod, $createdAt, $expiresAt, $ext)`,
			)
			.run({
				id: row.id,
				name: row.name.toLowerCase(),
				sender: row.sender,
				type: row.type,
				size: row.size,
				keyPeriod: row.key_period,
				createdAt: row.created_at,
				expiresAt: row.expires_at,
				ext: row.ext,
			});
		return result.changes > 0;
	}

	/** The live item with this name; an expired one is never returned. */
	vaultItem(name: string): VaultItemRow | undefined {
		return (
			(this.db
				.query("SELECT * FROM vault_items WHERE name = $name AND expires_at > $now")
				.get({ name: name.toLowerCase(), now: this.now() }) as VaultItemRow | null) ?? undefined
		);
	}

	/** Every live item, or with `ext` only that agent's items and the shared ones. */
	listVaultItems(ext?: string): VaultItemRow[] {
		const scope = ext === undefined ? "" : "AND (ext IS NULL OR ext = $ext)";
		return this.db
			.query(`SELECT * FROM vault_items WHERE expires_at > $now ${scope} ORDER BY created_at, name`)
			.all({ now: this.now(), ...(ext === undefined ? {} : { ext }) }) as VaultItemRow[];
	}

	/** True while any row, live or not yet pruned, holds the name. */
	vaultNameTaken(name: string): boolean {
		return this.db.query("SELECT 1 FROM vault_items WHERE name = $name").get({ name: name.toLowerCase() }) !== null;
	}

	removeVaultItem(id: string): void {
		this.db.query("DELETE FROM vault_items WHERE id = $id").run({ id });
	}

	private expiredId(id: string): boolean {
		return this.db.query("SELECT 1 FROM expired_ids WHERE id = $id AND expires_at > $now").get({ id, now: this.now() }) !== null;
	}

	private fileNames(sql: string, params: Record<string, number> = {}): Set<string> {
		const names = new Set<string>();
		for (const row of this.db.query(sql).all(params) as { file: string | null }[]) {
			const file = parseImageFile(row.file);
			const name = file && imageFileName(file);
			if (name) names.add(name);
		}
		return names;
	}

	/** Unlinks files of pruned rows, unreferenced files past the PHI window, and old temp writes; never follows a symlink. */
	private pruneFiles(doomed: ReadonlySet<string>, phiCutoff: number): void {
		const folder = join(this.dir, FILES_DIR);
		let names: string[];
		try {
			names = readdirSync(folder);
		} catch {
			return;
		}
		const referenced = this.fileNames("SELECT file FROM messages WHERE file IS NOT NULL AND direction = 'in'");
		const tmpCutoff = this.now() - TMP_GRACE_SECONDS;
		for (const name of names) {
			const path = join(folder, name);
			const stat = lstatSync(path, { throwIfNoEntry: false });
			if (!stat?.isFile()) continue;
			const age = stat.mtimeMs / 1000;
			const stale = name.endsWith(".tmp")
				? age < tmpCutoff
				: !referenced.has(name) && (doomed.has(name) || !FILE_NAME_PATTERN.test(name) || age < phiCutoff);
			if (stale) rmSync(path, { force: true });
		}
	}

	/** Drops expired outbox rows, then unlinks expired or unreferenced old files; never follows a symlink. */
	private pruneOutbox(cutoff: number, phiCutoff: number): void {
		const expired = new Set(
			(
				this.db
					.query("SELECT sha256 FROM outbox WHERE created_at < $cutoff OR (phi = 1 AND created_at < $phiCutoff)")
					.all({ cutoff, phiCutoff }) as { sha256: string }[]
			).map((row) => row.sha256),
		);
		this.transaction(() => {
			for (const sha of expired) this.removeOutbox(sha);
		});
		const folder = join(this.dir, OUTBOX_DIR);
		let names: string[];
		try {
			names = readdirSync(folder);
		} catch {
			return;
		}
		const known = this.db.query("SELECT 1 FROM outbox WHERE sha256 = $sha");
		for (const name of names) {
			const path = join(folder, name);
			const stat = lstatSync(path, { throwIfNoEntry: false });
			if (!stat?.isFile()) continue;
			const stale = expired.has(name) || (known.get({ sha: name }) === null && stat.mtimeMs / 1000 < phiCutoff);
			if (stale) rmSync(path, { force: true });
		}
	}

	getKey(id: string): KeyRow | undefined {
		return (this.db.query("SELECT * FROM keys WHERE id = $id").get({ id }) as KeyRow | null) ?? undefined;
	}

	listKeyIds(): string[] {
		return (this.db.query("SELECT id FROM keys ORDER BY id").all() as { id: string }[]).map((row) => row.id);
	}

	putKey(row: Omit<KeyRow, "created_at">): void {
		this.db
			.query(
				`INSERT INTO keys (id, nsec, in_store, created_at) VALUES ($id, $nsec, $inStore, $createdAt)
				ON CONFLICT(id) DO UPDATE SET nsec = $nsec, in_store = $inStore`,
			)
			.run({ id: row.id, nsec: row.nsec, inStore: row.in_store, createdAt: this.now() });
	}

	/** Inserts a key row with `makeDefault()`'s value only if `id` is absent, then reads back whichever row won the race. */
	ensureKeyRow(id: string, makeDefault: () => Pick<KeyRow, "nsec" | "in_store">): KeyRow {
		return this.transaction(() => {
			const existing = this.getKey(id);
			if (existing) return existing;
			const fresh = makeDefault();
			this.db
				.query(
					"INSERT OR IGNORE INTO keys (id, nsec, in_store, created_at) VALUES ($id, $nsec, $inStore, $createdAt)",
				)
				.run({ id, nsec: fresh.nsec, inStore: fresh.in_store, createdAt: this.now() });
			return this.getKey(id) as KeyRow;
		});
	}

	getContactByNpub(npub: string): ContactRow | undefined {
		return (
			(this.db.query("SELECT * FROM contacts WHERE npub = $npub").get({ npub }) as ContactRow | null) ?? undefined
		);
	}

	getContactByHandle(handle: string): ContactRow | undefined {
		return (
			(this.db.query("SELECT * FROM contacts WHERE handle = $handle").get({ handle }) as ContactRow | null) ??
			undefined
		);
	}

	listContacts(): ContactRow[] {
		return this.db.query("SELECT * FROM contacts ORDER BY handle").all() as ContactRow[];
	}

	/** Inserts only when neither the npub nor the handle exists; false means another writer got there first. */
	insertContact(row: ContactWrite): boolean {
		const { changes } = this.db
			.query(
				`INSERT INTO contacts (npub, handle, relays, key_id, added_at, via, origin_npub, runtime)
				VALUES ($npub, $handle, $relays, $keyId, $addedAt, $via, $origin, $runtime)
				ON CONFLICT DO NOTHING`,
			)
			.run({
				npub: row.npub,
				handle: row.handle,
				relays: row.relays,
				keyId: row.key_id,
				addedAt: row.added_at,
				via: row.via,
				origin: row.origin_npub ?? null,
				runtime: row.runtime ?? null,
			});
		return changes > 0;
	}

	putContact(row: ContactWrite): void {
		this.db
			.query(
				`INSERT INTO contacts (npub, handle, relays, key_id, added_at, via, origin_npub, runtime)
				VALUES ($npub, $handle, $relays, $keyId, $addedAt, $via, $origin, $runtime)
				ON CONFLICT(npub) DO UPDATE SET handle = $handle, relays = $relays, key_id = $keyId, via = $via,
					origin_npub = $origin, runtime = $runtime`,
			)
			.run({
				npub: row.npub,
				handle: row.handle,
				relays: row.relays,
				keyId: row.key_id,
				addedAt: row.added_at,
				via: row.via,
				origin: row.origin_npub ?? null,
				runtime: row.runtime ?? null,
			});
	}

	setContactKeyId(npub: string, keyId: string): void {
		this.db.query("UPDATE contacts SET key_id = $keyId WHERE npub = $npub").run({ keyId, npub });
	}

	/** Keeps the later of the stored and given time; returns the stored time from before this call. */
	touchLastSeen(npub: string, at: number): number | null {
		return this.transaction(() => {
			const before = (this.db.query("SELECT last_seen FROM contacts WHERE npub = $npub").get({ npub }) as { last_seen: number | null } | null)?.last_seen ?? null;
			this.db.query("UPDATE contacts SET last_seen = max(coalesce(last_seen, 0), $at) WHERE npub = $npub").run({ npub, at });
			return before;
		});
	}

	removeContact(npub: string): void {
		this.db.query("DELETE FROM contacts WHERE npub = $npub").run({ npub });
	}

	putIdentity(handle: string, keyId: string, runtime: string): void {
		this.db
			.query(
				`INSERT INTO identities (handle, key_id, runtime) VALUES ($handle, $keyId, $runtime)
				ON CONFLICT(handle) DO UPDATE SET key_id = $keyId, runtime = $runtime`,
			)
			.run({ handle, keyId, runtime });
	}

	listIdentities(): IdentityRow[] {
		return this.db.query("SELECT handle, key_id, runtime FROM identities ORDER BY handle").all() as IdentityRow[];
	}

	/** Insertion order, oldest first. Eviction walks this when the store is full. */
	identityHandlesByAge(): string[] {
		return (this.db.query("SELECT handle FROM identities ORDER BY rowid").all() as { handle: string }[]).map((row) => row.handle);
	}

	removeIdentity(handle: string): void {
		this.db.query("DELETE FROM identities WHERE handle = $handle").run({ handle });
	}

	readRosterSent(npub: string): string | undefined {
		const row = this.db.query("SELECT hash FROM roster_sent WHERE npub = $npub").get({ npub }) as { hash: string } | null;
		return row?.hash;
	}

	writeRosterSent(npub: string, hash: string): void {
		this.db
			.query(
				`INSERT INTO roster_sent (npub, hash, at) VALUES ($npub, $hash, $at)
				ON CONFLICT(npub) DO UPDATE SET hash = $hash, at = $at`,
			)
			.run({ npub, hash, at: this.now() });
	}

	clearRosterSent(npub: string): void {
		this.db.query("DELETE FROM roster_sent WHERE npub = $npub").run({ npub });
	}

	/** Keeps at most 8 held rosters. A repeat from the same npub replaces its row. */
	holdRoster(npub: string, body: string, intent: string): void {
		this.transaction(() => {
			const known = this.db.query("SELECT 1 FROM roster_held WHERE npub = $npub").get({ npub });
			if (!known) {
				const count = (this.db.query("SELECT count(*) AS n FROM roster_held").get() as { n: number }).n;
				if (count >= 8) {
					this.db.query("DELETE FROM roster_held WHERE npub = (SELECT npub FROM roster_held ORDER BY at, npub LIMIT 1)").run();
				}
			}
			this.db
				.query(
					`INSERT INTO roster_held (npub, body, intent, at) VALUES ($npub, $body, $intent, $at)
					ON CONFLICT(npub) DO UPDATE SET body = $body, intent = $intent, at = $at`,
				)
				.run({ npub, body, intent, at: this.now() });
		});
	}

	takeHeldRoster(npub: string): { body: string; intent: string } | undefined {
		const row = this.db.query("SELECT body, intent FROM roster_held WHERE npub = $npub").get({ npub }) as
			| { body: string; intent: string }
			| null;
		if (!row) return undefined;
		this.db.query("DELETE FROM roster_held WHERE npub = $npub").run({ npub });
		return row;
	}

	/** Notes that a contact's message named `ext` as its sender; a pubkey that is not a contact is ignored. */
	touchContactExt(npub: string, ext: string, at: number): void {
		this.transaction(() => {
			this.db
				.query(
					`INSERT INTO contact_exts (npub, ext, last_seen) SELECT $npub, $ext, $at WHERE EXISTS (SELECT 1 FROM contacts WHERE npub = $npub)
					ON CONFLICT(npub, ext) DO UPDATE SET last_seen = max(last_seen, $at)`,
				)
				.run({ npub, ext, at });
			this.db
				.query(
					"DELETE FROM contact_exts WHERE npub = $npub AND ext NOT IN (SELECT ext FROM contact_exts WHERE npub = $npub ORDER BY last_seen DESC, ext LIMIT $limit)",
				)
				.run({ npub, limit: CONTACT_EXT_LIMIT });
		});
	}

	contactExts(npub: string): ContactExtRow[] {
		return this.db.query("SELECT ext, last_seen FROM contact_exts WHERE npub = $npub ORDER BY last_seen DESC, ext").all({ npub }) as ContactExtRow[];
	}

	listLiveInvites(): InviteRow[] {
		return this.db
			.query("SELECT * FROM invites WHERE expires_at > $now ORDER BY expires_at")
			.all({ now: this.now() }) as InviteRow[];
	}

	putInvite(row: InviteRow): void {
		this.db
			.query(
				`INSERT INTO invites (secret, expires_at, as_name, name, key_id, relays)
				VALUES ($secret, $expiresAt, $asName, $name, $keyId, $relays)`,
			)
			.run({
				secret: row.secret,
				expiresAt: row.expires_at,
				asName: row.as_name,
				name: row.name,
				keyId: row.key_id,
				relays: row.relays ?? "[]",
			});
	}

	/** True only for the one call that removed a live invite, so two callers cannot both win it. */
	consumeInvite(secret: string): boolean {
		const result = this.db.query("DELETE FROM invites WHERE secret = $secret AND expires_at > $now").run({ secret, now: this.now() });
		return result.changes > 0;
	}

	addMessage(
		message: Omit<MessageRow, "read_at" | "attempts" | "thread_id" | "file" | "phi" | "received_at" | "delivered_at" | "ext" | "peer_ext"> & {
			thread_id?: string | null;
			file?: string | null;
			phi?: boolean;
			ext?: string | null;
			peer_ext?: string | null;
		},
	): boolean {
		this.pruneMessages();
		if (message.ts < this.cutoff() || this.expiredId(message.id)) return false;
		const result = this.db
			.query(
				`INSERT OR IGNORE INTO messages (id, direction, ts, sender, contact, text, call, read_at, attempts, thread_id, file, phi, received_at, ext, peer_ext)
				VALUES ($id, $direction, $ts, $sender, $contact, $text, $call, $readAt, 0, $threadId, $file, $phi, $receivedAt, $ext, $peerExt)`,
			)
			.run({
				id: message.id,
				direction: message.direction,
				ts: message.ts,
				sender: message.sender,
				contact: message.contact,
				text: message.text,
				call: message.call,
				readAt: message.direction === "out" ? this.now() : null,
				threadId: message.thread_id ?? null,
				file: message.file ?? null,
				phi: message.phi ? 1 : 0,
				receivedAt: this.now(),
				ext: message.ext ?? null,
				peerExt: message.peer_ext ?? null,
			});
		if (result.changes > 0 && message.direction === "out") this.applyEarlyReceipts(message.id);
		return result.changes > 0;
	}

	private applyEarlyReceipts(id: string): void {
		const held = this.db.query("SELECT signer, recipient, at FROM early_receipts WHERE id = $id ORDER BY at").all({ id }) as {
			signer: string;
			recipient: string;
			at: number;
		}[];
		for (const receipt of held) this.applyDelivered(id, receipt.signer, receipt.recipient, receipt.at);
		this.db.query("DELETE FROM early_receipts WHERE id = $id").run({ id });
	}

	addImageFetch(row: Omit<ImageFetchRow, "attempts">): void {
		this.db
			.query(
				`INSERT OR IGNORE INTO image_fetches (message_id, sender, key_id, x, ox, size, key, nonce, attempts, next_at, deadline)
				VALUES ($messageId, $sender, $keyId, $x, $ox, $size, $key, $nonce, 0, $nextAt, $deadline)`,
			)
			.run({
				messageId: row.message_id,
				sender: row.sender,
				keyId: row.key_id,
				x: row.x,
				ox: row.ox,
				size: row.size,
				key: row.key,
				nonce: row.nonce,
				nextAt: row.next_at,
				deadline: row.deadline,
			});
	}

	imageFetches(): ImageFetchRow[] {
		return this.db.query("SELECT * FROM image_fetches ORDER BY next_at, message_id").all() as ImageFetchRow[];
	}

	/** True when a received row that is not PHI already holds the image with plaintext hash `ox`. */
	hasPlainImage(ox: string): boolean {
		return (
			this.db
				.query("SELECT 1 FROM messages WHERE direction = 'in' AND phi = 0 AND file IS NOT NULL AND json_extract(file, '$.sha256') = $ox LIMIT 1")
				.get({ ox }) !== null
		);
	}

	pendingImageCount(): number {
		return (this.db.query("SELECT COUNT(*) AS n FROM image_fetches").get() as { n: number }).n;
	}

	/** Moves every deferred fetch from `sender` (hex pubkey) up to `now`. */
	retryImageFetchesFrom(sender: string, now: number): void {
		this.db.query("UPDATE image_fetches SET next_at = $now WHERE sender = $sender AND next_at > $now").run({ sender, now });
	}

	deferImageFetch(id: string, attempts: number, nextAt: number): void {
		this.db.query("UPDATE image_fetches SET attempts = $attempts, next_at = $nextAt WHERE message_id = $id").run({ id, attempts, nextAt });
	}

	/** Ends a fetch: drops its key and nonce, writes the final text, and makes the row unread again for the hook. */
	finishImage(id: string, text: string, file: string | null): void {
		this.transaction(() => {
			this.db.query("DELETE FROM image_fetches WHERE message_id = $id").run({ id });
			this.db.query("UPDATE messages SET text = $text, file = $file, read_at = NULL, attempts = 0 WHERE id = $id").run({ id, text, file });
			this.db.query("DELETE FROM ext_reads WHERE message_id = $id").run({ id });
		});
	}

	/** Records a staged outbox blob, the key that sent it, and the pubkeys allowed to fetch it. */
	addOutbox(sha256: string, keyId: string, recipients: readonly string[], opts: { phi?: boolean } = {}): void {
		this.transaction(() => {
			this.db
				.query("INSERT OR IGNORE INTO outbox (sha256, key_id, created_at, phi) VALUES ($sha256, $keyId, $createdAt, $phi)")
				.run({ sha256, keyId, createdAt: this.now(), phi: opts.phi ? 1 : 0 });
			const add = this.db.query("INSERT OR IGNORE INTO outbox_recipients (sha256, pubkey) VALUES ($sha256, $pubkey)");
			for (const pubkey of recipients) add.run({ sha256, pubkey });
		});
	}

	removeOutboxRecipient(sha256: string, pubkey: string): void {
		this.db.query("DELETE FROM outbox_recipients WHERE sha256 = $sha256 AND pubkey = $pubkey").run({ sha256, pubkey });
	}

	removeOutbox(sha256: string): void {
		this.db.query("DELETE FROM outbox_recipients WHERE sha256 = $sha256").run({ sha256 });
		this.db.query("DELETE FROM outbox WHERE sha256 = $sha256").run({ sha256 });
	}

	outboxKeyId(sha256: string): string | undefined {
		return (this.db.query("SELECT key_id FROM outbox WHERE sha256 = $sha256").get({ sha256 }) as { key_id: string } | null)?.key_id;
	}

	outboxRecipients(sha256: string): string[] {
		return (
			this.db.query("SELECT pubkey FROM outbox_recipients WHERE sha256 = $sha256 ORDER BY pubkey").all({ sha256 }) as {
				pubkey: string;
			}[]
		).map((row) => row.pubkey);
	}

	/** Inserts a message with its own `read_at`, unlike `addMessage` which infers it from
	 * direction; migration uses this to carry over an existing read mark exactly. */
	insertMigratedMessage(
		message: Omit<MessageRow, "attempts" | "thread_id" | "file" | "phi" | "received_at" | "delivered_at" | "ext" | "peer_ext"> & { thread_id?: string | null },
	): boolean {
		const result = this.db
			.query(
				`INSERT OR IGNORE INTO messages (id, direction, ts, sender, contact, text, call, read_at, attempts)
				VALUES ($id, $direction, $ts, $sender, $contact, $text, $call, $readAt, 0)`,
			)
			.run({
				id: message.id,
				direction: message.direction,
				ts: message.ts,
				sender: message.sender,
				contact: message.contact,
				text: message.text,
				call: message.call,
				readAt: message.read_at,
			});
		return result.changes > 0;
	}

	getMessage(id: string): MessageRow | undefined {
		return (this.db.query("SELECT * FROM messages WHERE id = $id").get({ id }) as MessageRow | null) ?? undefined;
	}

	unreadMessages(): MessageRow[] {
		return this.db
			.query("SELECT * FROM messages WHERE direction = 'in' AND read_at IS NULL ORDER BY ts, id")
			.all() as MessageRow[];
	}

	markRead(ids: string[]): void {
		this.transaction(() => {
			const mark = this.db.query("UPDATE messages SET read_at = $now WHERE id = $id");
			for (const id of ids) mark.run({ now: this.now(), id });
		});
	}

	/** Unread incoming rows in one view: the shared view reads `read_at`, an agent only its own marks. */
	unreadFor(ext: string | null): MessageRow[] {
		if (ext === null) {
			return this.db.query("SELECT * FROM messages WHERE direction = 'in' AND ext IS NULL AND read_at IS NULL ORDER BY ts, id").all() as MessageRow[];
		}
		return this.db
			.query(
				`SELECT * FROM messages WHERE direction = 'in' AND (ext IS NULL OR ext = $ext)
				AND NOT EXISTS (SELECT 1 FROM ext_reads WHERE message_id = messages.id AND ext = $ext) ORDER BY ts, id`,
			)
			.all({ ext }) as MessageRow[];
	}

	takeUnreadFor(ext: string | null, skip?: ReadonlySet<string>): MessageRow[] {
		return this.transaction(() => {
			const rows = this.unreadFor(ext).filter((row) => !skip?.has(row.id));
			if (ext === null) {
				this.markRead(rows.map((row) => row.id));
				return rows;
			}
			const mark = this.db.query("INSERT OR IGNORE INTO ext_reads (message_id, ext, read_at) VALUES ($id, $ext, $now)");
			for (const row of rows) mark.run({ id: row.id, ext, now: this.now() });
			return rows;
		});
	}

	/** Unread incoming rows held for each agent, which the shared view does not show. */
	waitingByExtension(): Record<string, number> {
		const rows = this.db
			.query(
				`SELECT ext, COUNT(*) AS n FROM messages WHERE direction = 'in' AND ext IS NOT NULL
				AND NOT EXISTS (SELECT 1 FROM ext_reads WHERE message_id = messages.id AND ext = messages.ext) GROUP BY ext ORDER BY ext`,
			)
			.all() as { ext: string; n: number }[];
		return Object.fromEntries(rows.map((row) => [row.ext, row.n]));
	}

	/** The oldest unread message still under the hook's attempt cap, or undefined once the queue is empty. */
	nextDeliverable(cap: number): MessageRow | undefined {
		return (
			(this.db
				.query(
					"SELECT * FROM messages WHERE direction = 'in' AND read_at IS NULL AND attempts < $cap AND sender != $sender AND NOT EXISTS (SELECT 1 FROM image_fetches WHERE message_id = messages.id) ORDER BY ts, id LIMIT 1",
				)
				.get({ cap, sender: PHONE_SYSTEM_SENDER }) as MessageRow | null) ?? undefined
		);
	}

	/** Unread messages that hit the hook's attempt cap; retried only on listener start and the stuck timer. */
	stuckMessages(cap: number): MessageRow[] {
		return this.db
			.query(
				"SELECT * FROM messages WHERE direction = 'in' AND read_at IS NULL AND attempts >= $cap AND sender != $sender AND NOT EXISTS (SELECT 1 FROM image_fetches WHERE message_id = messages.id) ORDER BY ts, id",
			)
			.all({ cap, sender: PHONE_SYSTEM_SENDER }) as MessageRow[];
	}

	bumpAttempts(id: string): number {
		return this.transaction(() => {
			this.db.query("UPDATE messages SET attempts = attempts + 1 WHERE id = $id").run({ id });
			const row = this.db.query("SELECT attempts FROM messages WHERE id = $id").get({ id }) as { attempts: number } | null;
			return row?.attempts ?? 0;
		});
	}

	/**
	 * The most recent `limit` messages, oldest first.
	 * A contact filter is one-to-one only (`thread_id` null). A thread filter is that room.
	 * With neither, every row is returned, thread rows included.
	 */
	recentMessages(limit: number, contactNpub?: string, threadId?: string, view?: ExtView): MessageRow[] {
		const where = [
			...(threadId !== undefined ? ["thread_id = $thread"] : contactNpub !== undefined ? ["contact = $contact", "thread_id IS NULL"] : []),
			...(view === undefined ? [] : view.ext === null ? ["ext IS NULL"] : ["(ext IS NULL OR ext = $ext)"]),
		];
		const params = {
			limit,
			...(threadId !== undefined ? { thread: threadId } : contactNpub !== undefined ? { contact: contactNpub } : {}),
			...(view?.ext ? { ext: view.ext } : {}),
		};
		const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
		const rows = this.db.query(`SELECT * FROM messages ${clause} ORDER BY ts DESC, id DESC LIMIT $limit`).all(params) as MessageRow[];
		rows.reverse();
		const ext = view?.ext;
		if (!ext) return rows;
		const readAt = this.db.query("SELECT read_at FROM ext_reads WHERE message_id = $id AND ext = $ext");
		return rows.map((row) =>
			row.direction === "out" ? row : { ...row, read_at: (readAt.get({ id: row.id, ext }) as { read_at: number } | null)?.read_at ?? null },
		);
	}

	/**
	 * Sets `delivered_at` once on our outgoing row or ping `id`, only when `signer` was a recipient
	 * and `to` is the npub that sent it. A thread row accepts any member. A receipt for an id not
	 * stored yet is held, since `text` saves its row after the relays answer.
	 */
	markDelivered(id: string, signer: string, to: string, at: number): boolean {
		if (this.applyDelivered(id, signer, to, at)) return true;
		const known = this.db.query("SELECT 1 FROM messages WHERE id = $id UNION ALL SELECT 1 FROM pings WHERE id = $id").get({ id });
		if (known !== null) return false;
		this.db.query("INSERT OR IGNORE INTO early_receipts (id, signer, recipient, at) VALUES ($id, $signer, $to, $at)").run({ id, signer, to, at });
		this.db
			.query("DELETE FROM early_receipts WHERE rowid NOT IN (SELECT rowid FROM early_receipts ORDER BY at DESC, rowid DESC LIMIT $limit)")
			.run({ limit: EARLY_RECEIPT_LIMIT });
		return false;
	}

	private applyDelivered(id: string, signer: string, to: string, at: number): boolean {
		const message = this.db
			.query(
				`UPDATE messages SET delivered_at = $at
				WHERE id = $id AND direction = 'out' AND delivered_at IS NULL AND sender = $to
				AND ((thread_id IS NULL AND contact = $signer)
					OR (thread_id IS NOT NULL AND EXISTS (SELECT 1 FROM thread_members WHERE thread_id = messages.thread_id AND npub = $signer)))`,
			)
			.run({ id, signer, to, at });
		if (message.changes > 0) return true;
		const ping = this.db
			.query("UPDATE pings SET delivered_at = $at WHERE id = $id AND delivered_at IS NULL AND contact = $signer AND sender = $to")
			.run({ id, signer, to, at });
		return ping.changes > 0;
	}

	addPing(row: Omit<PingRow, "delivered_at" | "busy_at">): void {
		this.db
			.query("INSERT OR IGNORE INTO pings (id, contact, sender, sent_at) VALUES ($id, $contact, $sender, $sentAt)")
			.run({ id: row.id, contact: row.contact, sender: row.sender, sentAt: row.sent_at });
	}

	pingRow(id: string): PingRow | undefined {
		return (this.db.query("SELECT * FROM pings WHERE id = $id").get({ id }) as PingRow | null) ?? undefined;
	}

	/** Records a rate-limited answer to our ping `id`, under the same recipient check as `markDelivered`. */
	markBusy(id: string, signer: string, to: string, at: number): boolean {
		const result = this.db
			.query("UPDATE pings SET busy_at = $at WHERE id = $id AND delivered_at IS NULL AND busy_at IS NULL AND contact = $signer AND sender = $to")
			.run({ id, signer, to, at });
		return result.changes > 0;
	}

	getThread(id: string): ThreadRow | undefined {
		return (this.db.query("SELECT * FROM threads WHERE id = $id").get({ id }) as ThreadRow | null) ?? undefined;
	}

	getThreadByHandle(handle: string): ThreadRow | undefined {
		return (
			(this.db.query("SELECT * FROM threads WHERE handle = $handle").get({ handle }) as ThreadRow | null) ?? undefined
		);
	}

	listThreads(): ThreadRow[] {
		return this.db.query("SELECT * FROM threads ORDER BY handle").all() as ThreadRow[];
	}

	insertThread(row: ThreadRow): void {
		this.db
			.query(
				`INSERT INTO threads (id, handle, subject, key_id, created_at, via)
				VALUES ($id, $handle, $subject, $keyId, $createdAt, $via)`,
			)
			.run({
				id: row.id,
				handle: row.handle,
				subject: row.subject,
				keyId: row.key_id,
				createdAt: row.created_at,
				via: row.via,
			});
	}

	listThreadMemberNpubs(threadId: string): string[] {
		return (
			this.db.query("SELECT npub FROM thread_members WHERE thread_id = $threadId ORDER BY npub").all({ threadId }) as {
				npub: string;
			}[]
		).map((row) => row.npub);
	}

	insertThreadMember(threadId: string, npub: string): void {
		this.db
			.query("INSERT INTO thread_members (thread_id, npub) VALUES ($threadId, $npub)")
			.run({ threadId, npub });
	}

	/** True when this rumor was neither held already nor expired as PHI. `received_at` is this phone's clock, not the sender's. */
	insertPending(row: Omit<PendingThreadRow, "noticed" | "received_at" | "phi"> & { phi?: boolean }): boolean {
		if (this.expiredId(row.rumor_id)) return false;
		const result = this.db
			.query(
				`INSERT OR IGNORE INTO pending_threads (rumor_id, room_id, sender, members, subject, text, ts, noticed, received_at, phi)
				VALUES ($rumorId, $roomId, $sender, $members, $subject, $text, $ts, 0, $receivedAt, $phi)`,
			)
			.run({
				rumorId: row.rumor_id,
				roomId: row.room_id,
				sender: row.sender,
				members: row.members,
				subject: row.subject,
				text: row.text,
				ts: row.ts,
				receivedAt: this.now(),
				phi: row.phi ? 1 : 0,
			});
		return result.changes > 0;
	}

	pendingByRumor(rumorId: string): PendingThreadRow | undefined {
		return (
			(this.db.query("SELECT * FROM pending_threads WHERE rumor_id = $rumorId").get({ rumorId }) as PendingThreadRow | null) ??
			undefined
		);
	}

	listPending(): PendingThreadRow[] {
		return this.db.query("SELECT * FROM pending_threads ORDER BY received_at, rumor_id").all() as PendingThreadRow[];
	}

	deletePending(ids: readonly string[]): void {
		const remove = this.db.query("DELETE FROM pending_threads WHERE rumor_id = $id");
		for (const id of ids) remove.run({ id });
	}

	heldNotice(): { text: string; ts: number } | undefined {
		const row = this.db.query("SELECT text, ts FROM messages WHERE id = 'phone-held-threads'").get() as
			| { text: string; ts: number }
			| null;
		return row ?? undefined;
	}

	/** Rewrites or removes the single held-threads notice so it matches the rows still stored. */
	syncHeldNotice(): void {
		const rooms = new Set(this.listPending().map((row) => row.room_id)).size;
		if (rooms === 0) {
			this.db.query("DELETE FROM messages WHERE id = 'phone-held-threads'").run();
			return;
		}
		const text = rooms === 1 ? "1 held group" : `${rooms} held groups`;
		this.upsertHeldNotice(text);
	}

	/** One unread system row for every currently held room. Rewriting it marks it unread again. */
	upsertHeldNotice(text: string): void {
		this.db
			.query(
				`INSERT INTO messages (id, direction, ts, sender, contact, text, call, read_at, attempts, thread_id)
				VALUES ($id, 'in', $ts, $sender, $sender, $text, 0, NULL, 0, NULL)
				ON CONFLICT(id) DO UPDATE SET text = $text, ts = $ts, read_at = NULL, attempts = 0`,
			)
			.run({ id: "phone-held-threads", ts: this.now(), sender: PHONE_SYSTEM_SENDER, text });
		this.db.query("DELETE FROM ext_reads WHERE message_id = 'phone-held-threads'").run();
	}

	get<T>(key: string): T | undefined {
		const row = this.db.query("SELECT value FROM settings WHERE key = $key").get({ key }) as
			| { value: string }
			| null;
		return row ? (JSON.parse(row.value) as T) : undefined;
	}

	set(key: string, value: unknown): void {
		this.db
			.query("INSERT INTO settings (key, value) VALUES ($key, $value) ON CONFLICT(key) DO UPDATE SET value = $value")
			.run({ key, value: JSON.stringify(value) });
	}

	/** Writes only when the key is absent, so the first of two racing writers wins; returns the stored value. */
	setOnce<T>(key: string, value: T): T {
		this.db
			.query("INSERT OR IGNORE INTO settings (key, value) VALUES ($key, $value)")
			.run({ key, value: JSON.stringify(value) });
		return this.get<T>(key) as T;
	}

	unset(key: string): void {
		this.db.query("DELETE FROM settings WHERE key = $key").run({ key });
	}

	transaction<T>(work: () => T): T {
		return this.db.transaction(work).immediate();
	}

	close(): void {
		this.db.close();
	}
}
