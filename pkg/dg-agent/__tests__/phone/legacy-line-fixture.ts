import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DgPaths } from "@dg/common/node";
import { DEFAULT_RELAYS } from "../../src/phone/store";

export type LegacyMessageFixture = {
	id: string;
	direction: "in" | "out";
	ts: number;
	sender: string;
	contact: string;
	text: string;
	call?: boolean;
	readAt?: number | null;
};

export type LegacyLineFixture = {
	contact?: string;
	name?: string;
	relays?: string[];
	nsec?: string;
	keyInStore?: boolean;
	invite?: { secret: string; expiresAt: number; name?: string; as?: string };
	cursor?: number;
	messages?: LegacyMessageFixture[];
	listenerPid?: number;
};

/** Builds a line database in the exact v1 shape phone-friend wrote it in, from the schema kept
 * here (see `git show 70fc701:pkg/dg-agent/src/phone-friend/db.ts`), so the migration under test
 * reads real legacy bytes rather than a stand-in fixture format. */
export function writeLegacyLine(paths: Pick<DgPaths, "phoneFriendRoot">, line: string, fixture: LegacyLineFixture): void {
	const dir = join(paths.phoneFriendRoot, line);
	mkdirSync(dir, { recursive: true });
	const db = new Database(join(dir, "phone-friend.db"), { create: true, strict: true });
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
	db.run("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT");
	const setSetting = (key: string, value: unknown) =>
		db.query("INSERT INTO settings (key, value) VALUES ($key, $value)").run({ key, value: JSON.stringify(value) });
	if (fixture.contact !== undefined || fixture.name !== undefined || fixture.relays !== undefined) {
		setSetting("config", {
			relays: fixture.relays ?? DEFAULT_RELAYS,
			contact: fixture.contact,
			name: fixture.name,
		});
	}
	if (fixture.nsec !== undefined) setSetting("nsec", fixture.nsec);
	if (fixture.keyInStore) setSetting("key_in_store", true);
	if (fixture.invite !== undefined) setSetting("invite", fixture.invite);
	if (fixture.cursor !== undefined) setSetting("cursor", fixture.cursor);
	const insertMessage = db.query(
		`INSERT INTO messages (id, direction, ts, sender, contact, text, call, read_at)
		VALUES ($id, $direction, $ts, $sender, $contact, $text, $call, $readAt)`,
	);
	for (const message of fixture.messages ?? []) {
		insertMessage.run({
			id: message.id,
			direction: message.direction,
			ts: message.ts,
			sender: message.sender,
			contact: message.contact,
			text: message.text,
			call: message.call ? 1 : 0,
			readAt: message.readAt ?? null,
		});
	}
	db.close();
	if (fixture.listenerPid !== undefined) {
		writeFileSync(join(dir, "listener.pid"), `${fixture.listenerPid}\n`);
	}
}
