import { Database } from "bun:sqlite";
import { chmodSync, writeFileSync } from "node:fs";
import {
	applyConnectionPragmas,
	type DgPaths,
	ensurePrivateDir,
	type MigrationStep,
	runMigrations,
} from "@dg/common/node";
import { join } from "node:path";

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
};

export type KeyRow = { id: string; nsec: string | null; in_store: number; created_at: number };

export type ContactRow = {
	npub: string;
	handle: string;
	relays: string;
	key_id: string;
	added_at: number;
	via: string;
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
];

/** One SQLite file for every key, contact, invite, and message, shared across the whole phone. */
export class PhoneDb {
	private constructor(
		private readonly db: Database,
		private readonly now: () => number,
	) {}

	static path(paths: DgPaths): string {
		return join(paths.phoneRoot, "phone.db");
	}

	static open(paths: DgPaths, now: () => number = () => Math.floor(Date.now() / 1000)): PhoneDb {
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
		const opened = new PhoneDb(db, now);
		opened.pruneMessages();
		return opened;
	}

	private cutoff(): number {
		return this.now() - MESSAGE_TTL_SECONDS;
	}

	pruneMessages(): void {
		this.db.query("DELETE FROM messages WHERE ts < $cutoff").run({ cutoff: this.cutoff() });
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
	insertContact(row: ContactRow): boolean {
		const { changes } = this.db
			.query(
				`INSERT INTO contacts (npub, handle, relays, key_id, added_at, via)
				VALUES ($npub, $handle, $relays, $keyId, $addedAt, $via)
				ON CONFLICT DO NOTHING`,
			)
			.run({
				npub: row.npub,
				handle: row.handle,
				relays: row.relays,
				keyId: row.key_id,
				addedAt: row.added_at,
				via: row.via,
			});
		return changes > 0;
	}

	putContact(row: ContactRow): void {
		this.db
			.query(
				`INSERT INTO contacts (npub, handle, relays, key_id, added_at, via)
				VALUES ($npub, $handle, $relays, $keyId, $addedAt, $via)
				ON CONFLICT(npub) DO UPDATE SET handle = $handle, relays = $relays, key_id = $keyId, via = $via`,
			)
			.run({
				npub: row.npub,
				handle: row.handle,
				relays: row.relays,
				keyId: row.key_id,
				addedAt: row.added_at,
				via: row.via,
			});
	}

	setContactKeyId(npub: string, keyId: string): void {
		this.db.query("UPDATE contacts SET key_id = $keyId WHERE npub = $npub").run({ keyId, npub });
	}

	removeContact(npub: string): void {
		this.db.query("DELETE FROM contacts WHERE npub = $npub").run({ npub });
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

	addMessage(message: Omit<MessageRow, "read_at" | "attempts">): boolean {
		this.pruneMessages();
		if (message.ts < this.cutoff()) return false;
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
				readAt: message.direction === "out" ? this.now() : null,
			});
		return result.changes > 0;
	}

	/** Inserts a message with its own `read_at`, unlike `addMessage` which infers it from
	 * direction; migration uses this to carry over an existing read mark exactly. */
	insertMigratedMessage(message: Omit<MessageRow, "attempts">): boolean {
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

	takeUnread(skip?: ReadonlySet<string>): MessageRow[] {
		return this.transaction(() => {
			const rows = this.unreadMessages().filter((row) => !skip?.has(row.id));
			this.markRead(rows.map((row) => row.id));
			return rows;
		});
	}

	/** The oldest unread message still under the hook's attempt cap, or undefined once the queue is empty. */
	nextDeliverable(cap: number): MessageRow | undefined {
		return (
			(this.db
				.query(
					"SELECT * FROM messages WHERE direction = 'in' AND read_at IS NULL AND attempts < $cap AND sender != $sender ORDER BY ts, id LIMIT 1",
				)
				.get({ cap, sender: PHONE_SYSTEM_SENDER }) as MessageRow | null) ?? undefined
		);
	}

	/** Unread messages that hit the hook's attempt cap; retried only on listener start and the stuck timer. */
	stuckMessages(cap: number): MessageRow[] {
		return this.db
			.query(
				"SELECT * FROM messages WHERE direction = 'in' AND read_at IS NULL AND attempts >= $cap AND sender != $sender ORDER BY ts, id",
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

	/** The most recent `limit` messages for a contact (or every contact), oldest first. */
	recentMessages(limit: number, contactNpub?: string): MessageRow[] {
		const rows = (
			contactNpub === undefined
				? this.db.query("SELECT * FROM messages ORDER BY ts DESC, id DESC LIMIT $limit").all({ limit })
				: this.db
						.query("SELECT * FROM messages WHERE contact = $contact ORDER BY ts DESC, id DESC LIMIT $limit")
						.all({ contact: contactNpub, limit })
		) as MessageRow[];
		return rows.reverse();
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
