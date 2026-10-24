import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDgPaths } from "@dg/common/node";
import { generateSecretKey, getPublicKey, type Filter, nip19, type NostrEvent } from "nostr-tools";
import type { SubscribeManyParams } from "nostr-tools/pool";
import type { PhoneDeps } from "../../src/phone/commands";
import { PhoneDb } from "../../src/phone/db";
import type { KeyClient } from "../../src/phone/keys";
import type { PhonePool } from "../../src/phone/chat";

export type FakePool = PhonePool & {
	events: NostrEvent[];
	filters: Filter[];
	listeners: ((event: NostrEvent) => void)[];
	relaysUsed: string[][];
};

/** A fresh npub with no corresponding contact. */
export function freshNpub(): string {
	return nip19.npubEncode(getPublicKey(generateSecretKey()));
}

/** One temp directory under `prefix`; the caller is responsible for removing it. */
export function makeTempHome(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

/** Tracks every temp home dir and `PhoneDb` a spec opens, so one `cleanup()` closes and removes them all. */
export function makeHomeTracker(prefix: string): {
	freshHome: () => string;
	trackDb: (db: PhoneDb) => void;
	cleanup: () => void;
} {
	const homes: string[] = [];
	const dbs: PhoneDb[] = [];
	return {
		freshHome: () => {
			const home = makeTempHome(prefix);
			homes.push(home);
			return home;
		},
		trackDb: (db: PhoneDb) => {
			dbs.push(db);
		},
		cleanup: () => {
			for (const db of dbs) db.close();
			for (const home of homes) rmSync(home, { recursive: true, force: true });
		},
	};
}

/** NDJSON stdout, one JSON value per line. */
export function parseNdjson(rows: string[]): unknown[] {
	return rows
		.join("")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((row) => JSON.parse(row));
}

/** The file-mode `PhoneDeps` every CLI-level phone spec needs: a fresh db at `home`, no credential-store grant. */
export function makePhoneDeps(opts: { home: string; pool: FakePool; write: (text: string) => void; now?: number }): PhoneDeps {
	const now = opts.now ?? Math.floor(Date.now() / 1000);
	const paths = resolveDgPaths({ env: { DG_HOME: opts.home } });
	const db = PhoneDb.open(paths, () => now);
	return {
		paths,
		db,
		createPool: () => ({ ...opts.pool, close: () => {} }),
		write: opts.write,
		readStdin: async () => undefined,
		now: () => now,
		sessionClient: async () => undefined,
		grantClient: (): KeyClient => {
			throw new Error("no grant in file-mode tests");
		},
	};
}

export function createFakePool(accepting: string[] | "all" = "all"): FakePool {
	const pool: FakePool = {
		events: [],
		filters: [],
		listeners: [],
		relaysUsed: [],
		publish(relays, event) {
			return relays.map((relay) => {
				if (accepting !== "all" && !accepting.includes(relay)) {
					return Promise.reject(new Error(`${relay} refused`));
				}
				pool.events.push(event);
				for (const listener of pool.listeners) listener(event);
				return Promise.resolve("");
			});
		},
		async querySync(relays, filter) {
			pool.relaysUsed.push(relays);
			pool.filters.push(filter);
			return pool.events.filter(
				(event) =>
					event.created_at >= (filter.since ?? 0) &&
					(!filter.kinds || filter.kinds.includes(event.kind)) &&
					(!filter["#p"] || event.tags.some((tag) => tag[0] === "p" && filter["#p"]?.includes(tag[1] as string))),
			);
		},
		subscribe(relays, filter, params: SubscribeManyParams) {
			pool.relaysUsed.push(relays);
			pool.filters.push(filter);
			const listener = (event: NostrEvent) => params.onevent?.(event);
			pool.listeners.push(listener);
			return {
				close: () => {
					pool.listeners = pool.listeners.filter((l) => l !== listener);
				},
			};
		},
	};
	return pool;
}
