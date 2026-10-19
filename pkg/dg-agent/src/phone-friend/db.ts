import { Database } from "bun:sqlite";
import { chmodSync, writeFileSync } from "node:fs";
import {
	applyConnectionPragmas,
	ensurePrivateDir,
	type MigrationStep,
	runMigrations,
} from "@dg/common/node";
import type { Message, Seen } from "./chat";
import type { LinePaths } from "./line";

export type Direction = "in" | "out";
export type StoredMessage = Message & { direction: Direction; contact: string };

/** Messages older than this are deleted, and relay queries never reach further back. */
export const MESSAGE_TTL_SECONDS = 7 * 24 * 60 * 60;

const SCHEMA: MigrationStep[] = [
	{
		version: 1,
		run: (db) => {
			db.run(`CREATE TABLE messages (
				id TEXT PRIMARY KEY,
				direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
				ts INTEGER NOT NULL,
				sender TEXT NOT NULL,
				contact TEXT NOT NULL,
				text TEXT NOT NULL,
				call INTEGER NOT NULL DEFAULT 0,
				read_at INTEGER
			) STRICT`);
			db.run("CREATE INDEX idx_messages_ts ON messages(ts)");
			db.run(
				"CREATE INDEX idx_messages_unread ON messages(ts) WHERE direction = 'in' AND read_at IS NULL",
			);
			db.run("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT");
		},
	},
];

type Row = {
	id: string;
	direction: Direction;
	ts: number;
	sender: string;
	contact: string;
	text: string;
	call: number;
};

function toMessage(row: Row): Message {
	return {
		id: row.id,
		ts: row.ts,
		from: row.sender,
		text: row.text,
		...(row.call ? { call: true as const } : {}),
	};
}

/** One SQLite file per line holds its settings, its key in file mode, and its messages. */
export class PhoneFriendDb {
	private constructor(
		private readonly db: Database,
		private readonly now: () => number,
	) {}

	static open(line: LinePaths, now: () => number = () => Math.floor(Date.now() / 1000)): PhoneFriendDb {
		ensurePrivateDir(line.dir);
		writeFileSync(line.dbPath, "", { mode: 0o600, flag: "a" });
		chmodSync(line.dbPath, 0o600);
		const db = new Database(line.dbPath, { strict: true, create: true, readwrite: true });
		try {
			applyConnectionPragmas(db);
			db.run("PRAGMA secure_delete = ON");
			runMigrations(db, SCHEMA);
		} catch (err) {
			db.close(true);
			throw err;
		}
		const opened = new PhoneFriendDb(db, now);
		opened.prune();
		return opened;
	}

	private cutoff(): number {
		return this.now() - MESSAGE_TTL_SECONDS;
	}

	prune(): void {
		this.db.query("DELETE FROM messages WHERE ts < $cutoff").run({ cutoff: this.cutoff() });
	}

	/** Returns false for a repeat id or a message already past the ttl. */
	add(message: Message, direction: Direction, contact: string): boolean {
		this.prune();
		if (message.ts < this.cutoff()) return false;
		const result = this.db
			.query(
				`INSERT OR IGNORE INTO messages (id, direction, ts, sender, contact, text, call, read_at)
				VALUES ($id, $direction, $ts, $sender, $contact, $text, $call, $readAt)`,
			)
			.run({
				id: message.id,
				direction,
				ts: message.ts,
				sender: message.from,
				contact,
				text: message.text,
				call: message.call ? 1 : 0,
				readAt: direction === "out" ? this.now() : null,
			});
		return result.changes > 0;
	}

	takeUnread(): Message[] {
		return this.db.transaction(() => {
			const rows = this.db
				.query(
					"SELECT * FROM messages WHERE direction = 'in' AND read_at IS NULL ORDER BY ts, id",
				)
				.all() as Row[];
			const mark = this.db.query("UPDATE messages SET read_at = $now WHERE id = $id");
			for (const row of rows) mark.run({ now: this.now(), id: row.id });
			return rows.map(toMessage);
		})();
	}

	history(): StoredMessage[] {
		const rows = this.db.query("SELECT * FROM messages ORDER BY ts, id").all() as Row[];
		return rows.map((row) => ({ ...toMessage(row), direction: row.direction, contact: row.contact }));
	}

	seen(): Seen {
		const ids = (this.db.query("SELECT id FROM messages ORDER BY rowid").all() as { id: string }[]).map(
			(row) => row.id,
		);
		return { cursor: this.get<number>("cursor") ?? 0, ids };
	}

	setCursor(cursor: number): void {
		this.set("cursor", cursor);
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
		return this.db.transaction(work)();
	}

	close(): void {
		this.db.close();
	}
}
