import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DgCliError } from "@dg/common";
import {
	credentialGrantTokenPath,
	DaemonNotRunningError,
	type DgPaths,
	resolveDgPaths,
	writeCredentialGrantToken,
} from "@dg/common/node";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { PhoneDb } from "../../src/phone/db";
import {
	cleanUpOrphan,
	createFileKey,
	ensureKey,
	GRANT_PREFIX,
	type KeyClient,
	type KeyDeps,
	keyName,
	loadAllKeys,
	loadKey,
	markKeyInStore,
	readFileKey,
} from "../../src/phone/keys";

let home: string;
let paths: DgPaths;
let db: PhoneDb;
let KEY_NAME: string;
let store: Map<string, string>;
let daemonUp: boolean;
let calls: string[];

function client(overrides: Partial<KeyClient> = {}): KeyClient {
	const down = () => {
		if (!daemonUp) throw new DaemonNotRunningError();
	};
	return {
		async get(name) {
			down();
			calls.push(`get ${name}`);
			const value = store.get(name);
			return value === undefined ? undefined : { value, meta: {}, updatedAt: "" };
		},
		async set(name, value) {
			down();
			calls.push(`set ${name}`);
			store.set(name, value);
		},
		async delete(name) {
			down();
			calls.push(`delete ${name}`);
			return store.delete(name);
		},
		async grant(prefix) {
			down();
			calls.push(`grant ${prefix}`);
			writeCredentialGrantToken(paths, prefix, "t".repeat(64));
			return { prefix, path: credentialGrantTokenPath(paths, prefix) };
		},
		close() {},
		...overrides,
	};
}

function deps(options: { session?: boolean; client?: Partial<KeyClient> } = {}): KeyDeps {
	return {
		paths,
		db,
		sessionClient: async () => (options.session && daemonUp ? client(options.client) : undefined),
		grantClient: () => client(options.client),
	};
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "dg-phone-keys-"));
	paths = resolveDgPaths({ env: { DG_HOME: home } });
	db = PhoneDb.open(paths);
	KEY_NAME = keyName("default");
	store = new Map();
	daemonUp = true;
	calls = [];
});

afterEach(() => {
	db.close();
	rmSync(home, { recursive: true, force: true });
});

describe("cleanUpOrphan", () => {
	it("deletes the credential when the store still holds this call's own value", async () => {
		store.set(KEY_NAME, "nsec1ownvalue");

		await cleanUpOrphan(client(), KEY_NAME, "nsec1ownvalue");

		expect(store.has(KEY_NAME)).toBe(false);
	});

	it("leaves another call's committed key alone when it no longer matches this call's own value", async () => {
		store.set(KEY_NAME, "nsec1winnervalue");

		await cleanUpOrphan(client(), KEY_NAME, "nsec1ownvalue");

		expect(store.get(KEY_NAME)).toBe("nsec1winnervalue");
	});

	it("does nothing when the store never received this call's value", async () => {
		await cleanUpOrphan(client(), KEY_NAME, "nsec1ownvalue");

		expect(store.has(KEY_NAME)).toBe(false);
	});
});

describe("ensureKey", () => {
	it("puts the first key in the store and makes a grant when a session exists", async () => {
		const { sk, mode } = await ensureKey(deps({ session: true }), "default");

		expect(mode).toBe("store");
		expect(store.get(KEY_NAME)).toBe(nip19.nsecEncode(sk));
		expect(existsSync(credentialGrantTokenPath(paths, GRANT_PREFIX))).toBe(true);
		expect(readFileKey(db, "default")).toBeUndefined();
	});

	it("keeps the key in the 0600 phone database when no session exists", async () => {
		const { mode } = await ensureKey(deps(), "default");

		expect(mode).toBe("file");
		expect(readFileKey(db, "default")).toBeDefined();
		expect(statSync(PhoneDb.path(paths)).mode & 0o777).toBe(0o600);
		expect(store.size).toBe(0);
	});

	it("moves a file key to the store and drops the file copy after a matching read-back", async () => {
		const original = createFileKey(db, "default") as Uint8Array;

		const { sk, mode } = await ensureKey(deps({ session: true }), "default");

		expect(mode).toBe("store");
		expect(Buffer.from(sk).equals(Buffer.from(original))).toBe(true);
		expect(store.get(KEY_NAME)).toBe(nip19.nsecEncode(original));
		expect(readFileKey(db, "default")).toBeUndefined();
		expect(calls).toEqual([`set ${KEY_NAME}`, `grant ${GRANT_PREFIX}`, `get ${KEY_NAME}`]);
	});

	it("keeps the file key and leaves the store secret alone when the read-back does not match this call's own write", async () => {
		const original = createFileKey(db, "default") as Uint8Array;

		const { sk, mode } = await ensureKey(
			deps({ session: true, client: { get: async () => ({ value: "nsec1wrong", meta: {}, updatedAt: "" }) } }),
			"default",
		);

		expect(mode).toBe("file");
		expect(Buffer.from(sk).equals(Buffer.from(original))).toBe(true);
		expect(readFileKey(db, "default")).toBeDefined();
		expect(store.get(KEY_NAME)).toBe(nip19.nsecEncode(sk));
	});

	it("keeps the file key when the store refuses the write", async () => {
		createFileKey(db, "default");

		const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			const { mode } = await ensureKey(
				deps({
					session: true,
					client: {
						set: async () => {
							throw new DgCliError("refused");
						},
					},
				}),
				"default",
			);

			expect(mode).toBe("file");
			expect(String(stderr.mock.calls[0]?.[0])).toContain("did not take the key");
			expect(String(stderr.mock.calls[0]?.[0])).toContain("refused");
		} finally {
			stderr.mockRestore();
		}
		expect(readFileKey(db, "default")).toBeDefined();
	});

	it("cleans up the orphaned store secret when grant fails after set succeeds", async () => {
		const { mode } = await ensureKey(
			deps({
				session: true,
				client: {
					grant: async () => {
						throw new DgCliError("grant refused");
					},
				},
			}),
			"default",
		);

		expect(mode).toBe("file");
		expect(store.has(KEY_NAME)).toBe(false);
		expect(readFileKey(db, "default")).toBeDefined();
	});

	it("adopts the key of a run that won the race to the store instead of making a file key", async () => {
		const winner = generateSecretKey();

		const { sk, mode } = await ensureKey(
			deps({
				session: true,
				client: {
					set: async (name) => {
						calls.push(`set ${name}`);
						store.set(name, nip19.nsecEncode(winner));
						markKeyInStore(db, "default", winner);
					},
				},
			}),
			"default",
		);

		expect(mode).toBe("store");
		expect(Buffer.from(sk).equals(Buffer.from(winner))).toBe(true);
		expect(readFileKey(db, "default")).toBeUndefined();
	});

	it("reuses the store key and never makes a second one", async () => {
		const first = await ensureKey(deps({ session: true }), "default");
		const second = await ensureKey(deps({ session: true }), "default");

		expect(Buffer.from(second.sk).equals(Buffer.from(first.sk))).toBe(true);
		expect(calls.filter((call) => call.startsWith("set"))).toHaveLength(1);
	});

	it("fails in store mode with the daemon down, and makes no new key", async () => {
		await ensureKey(deps({ session: true }), "default");
		daemonUp = false;

		await expect(ensureKey(deps({ session: true }), "default")).rejects.toThrow("not reachable");

		expect(readFileKey(db, "default")).toBeUndefined();
	});
});

describe("loadKey", () => {
	it("returns undefined before any key exists", async () => {
		expect(await loadKey(deps(), "default")).toBeUndefined();
	});

	it("reads a store key through the grant client", async () => {
		const made = await ensureKey(deps({ session: true }), "default");
		calls = [];

		const loaded = await loadKey(deps(), "default");

		expect(loaded?.mode).toBe("store");
		expect(Buffer.from(loaded?.sk ?? []).equals(Buffer.from(made.sk))).toBe(true);
		expect(calls).toEqual([`get ${KEY_NAME}`]);
	});

	it("fails when the key is in store mode but the store has no key", async () => {
		markKeyInStore(db, "default", generateSecretKey());

		await expect(loadKey(deps(), "default")).rejects.toBeInstanceOf(DgCliError);
	});

	it("never puts the stored value in an error", async () => {
		markKeyInStore(db, "default", generateSecretKey());
		store.set(KEY_NAME, "nsec1notarealkeybutsecret");

		const failure = loadKey(deps(), "default");

		await expect(failure).rejects.toBeInstanceOf(DgCliError);
		await expect(failure).rejects.not.toThrow("nsec1notarealkeybutsecret");
	});

	it("reads a file key without a daemon", async () => {
		daemonUp = false;
		createFileKey(db, "default");

		expect((await loadKey(deps(), "default"))?.mode).toBe("file");
	});
});

describe("multiple keys", () => {
	it("gives each key id its own identity and its own store name", async () => {
		const number = await ensureKey(deps({ session: true }), "default");
		const legacy = await ensureKey(deps({ session: true }), "work");

		expect(Buffer.from(number.sk).equals(Buffer.from(legacy.sk))).toBe(false);
		expect(store.get(keyName("work"))).toBe(nip19.nsecEncode(legacy.sk));
		expect(keyName("work")).toBe("phone-friend/work/nostr-key");
	});
});

describe("loadAllKeys", () => {
	it("loads every key row the database knows, keyed by id and public key", async () => {
		const number = await ensureKey(deps({ session: true }), "default");
		const legacy = await ensureKey(deps({ session: true }), "work");

		const loaded = await loadAllKeys(deps({ session: true }));

		expect(loaded.unreadable).toEqual([]);
		expect(loaded.keys.map((key) => key.id).sort()).toEqual(["default", "work"]);
		const byId = new Map(loaded.keys.map((key) => [key.id, key]));
		expect(byId.get("default")?.pub).toBe(getPublicKey(number.sk));
		expect(byId.get("work")?.pub).toBe(getPublicKey(legacy.sk));
	});

	it("is empty when no key has ever been created", async () => {
		expect(await loadAllKeys(deps())).toEqual({ keys: [], unreadable: [] });
	});

	it("reports a key row whose store is unreachable instead of dropping it", async () => {
		await ensureKey(deps({ session: true }), "default");
		markKeyInStore(db, "work", generateSecretKey());
		store.delete(keyName("work"));

		const loaded = await loadAllKeys(deps());

		expect(loaded.keys.map((key) => key.id)).toEqual(["default"]);
		expect(loaded.unreadable).toEqual(["work"]);
	});
});
