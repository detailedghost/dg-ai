import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DgCliError, validateCredentialName } from "@dg/common";
import { type DgPaths, resolveDgPaths } from "@dg/common/node";
import { PhoneDb } from "../../src/phone/db";
import {
	createVaultKeyCache,
	keyPeriodEnd,
	deleteVaultItem,
	dropOldKeys,
	ensurePeriodKey,
	isVaultName,
	keyPeriod,
	openVaultItem,
	receivedName,
	storeVaultItem,
	VAULT_DIR,
	VAULT_TTL_SECONDS,
	vaultKeyName,
} from "../../src/phone/vault";
import { createFakeCredentials, type FakeCredentials } from "./fake-vault";

const NOW = 1_800_000_000;
let home: string;
let paths: DgPaths;
let now: number;
let db: PhoneDb;
let creds: FakeCredentials;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "dg-phone-vault-"));
	paths = resolveDgPaths({ env: { DG_HOME: home } });
	now = NOW;
	db = PhoneDb.open(paths, () => now);
	creds = createFakeCredentials();
});

afterEach(() => {
	db.close();
	rmSync(home, { recursive: true, force: true });
});

function vaultDir(): string {
	return join(paths.phoneRoot, VAULT_DIR);
}

async function todayKey() {
	const day = keyPeriod(now);
	return { period: day, key: await ensurePeriodKey(creds.keyDeps(paths), day) };
}

describe("vault names", () => {
	it("accepts lowercase names up to 64 characters", () => {
		for (const name of ["a", "lab-1.txt", "mom_2", "0", "a".repeat(64)]) expect(isVaultName(name)).toBe(true);
	});

	it("accepts either letter case, and rejects empty, leading punctuation, slashes, dot-dot, and long names", () => {
		for (const name of ["A", "Warren-Probe", "LAB_1.TXT"]) expect(isVaultName(name)).toBe(true);
		for (const name of ["", "-x", ".x", "a/b", "a..b", "A..B", "a b", "a".repeat(65), "é"]) expect(isVaultName(name)).toBe(false);
	});

	it("names a received item by handle, local minute, and four random hex digits", () => {
		const at = new Date(2026, 10, 4, 9, 7).getTime() / 1000;
		expect(receivedName("mom", at, () => false)).toMatch(/^mom-202611040907-[0-9a-f]{4}$/);
	});

	it("stores one row for every spelling of a name", () => {
		const row = {
			id: "a".repeat(32),
			name: "Foo",
			sender: "self",
			type: "text/plain",
			size: 1,
			key_period: "2026-w46",
			created_at: now,
			expires_at: now + VAULT_TTL_SECONDS,
			ext: null,
		};
		expect(db.addVaultItem(row)).toBe(true);
		expect(db.vaultItem("FOO")?.name).toBe("foo");
		expect(db.vaultNameTaken("fOo")).toBe(true);
		expect(db.addVaultItem({ ...row, id: "b".repeat(32), name: "FOO" })).toBe(false);
	});

	it("uses unknown when the sender has no handle, and skips a taken name", () => {
		const seen: string[] = [];
		const name = receivedName(undefined, NOW, (candidate) => {
			seen.push(candidate);
			return seen.length === 1;
		});
		expect(name).toMatch(/^unknown-\d{12}-[0-9a-f]{4}$/);
		expect(seen.length).toBe(2);
		expect(isVaultName(name)).toBe(true);
	});
});

function at(y: number, m: number, d: number, h = 0, min = 0, sec = 0): number {
	return new Date(y, m - 1, d, h, min, sec).getTime() / 1000;
}

describe("keyPeriod", () => {
	it("names the ISO week of the local date", () => {
		expect(keyPeriod(at(2026, 11, 4, 12))).toBe("2026-w45");
		expect(keyPeriod(at(2026, 11, 2, 0, 0, 0))).toBe("2026-w45");
		expect(keyPeriod(at(2026, 11, 1, 23, 59, 59))).toBe("2026-w44");
		expect(keyPeriod(at(2026, 11, 8, 23, 59, 59))).toBe("2026-w45");
	});

	it("stays unambiguous across year ends", () => {
		expect(keyPeriod(at(2026, 12, 31))).toBe("2026-w53");
		expect(keyPeriod(at(2027, 1, 3, 23, 59))).toBe("2026-w53");
		expect(keyPeriod(at(2027, 1, 4))).toBe("2027-w01");
		expect(keyPeriod(at(2024, 12, 30))).toBe("2025-w01");
		expect(keyPeriod(at(2021, 1, 1))).toBe("2020-w53");
	});

	it("steps whole periods", () => {
		expect(keyPeriod(at(2026, 12, 30), 1)).toBe("2027-w01");
		expect(keyPeriod(at(2026, 12, 30), -1)).toBe("2026-w52");
		expect(keyPeriod(at(2027, 1, 5), -1)).toBe("2026-w53");
	});

	it("pads the week number so names sort in time order", () => {
		expect(keyPeriod(at(2026, 1, 12))).toBe("2026-w03");
		expect(vaultKeyName(keyPeriod(at(2026, 1, 12)))).toBe("phone-vault/2026-w03");
	});

	it("emits a lowercase week the credential store accepts", () => {
		expect(keyPeriod(at(2026, 11, 13))).toBe("2026-w46");
		expect(validateCredentialName(vaultKeyName(keyPeriod(at(2026, 11, 13))))).toBe("phone-vault/2026-w46");
		expect(validateCredentialName("phone-vault/2026-W46")).toBe("phone-vault/2026-w46");
		expect(validateCredentialName("Warren-Probe")).toBe("warren-probe");
	});

	it("parses an uppercase or lowercase week as the same end, and rejects other text", () => {
		const end = keyPeriodEnd("2026-W46");
		expect(end).toBe(at(2026, 11, 16));
		expect(keyPeriodEnd("2026-w46")).toBe(end);
		expect(keyPeriodEnd("2026-w6")).toBeUndefined();
		expect(keyPeriodEnd("2026-X46")).toBeUndefined();
		expect(keyPeriodEnd("2026-w46extra")).toBeUndefined();
		expect(keyPeriodEnd("x2026-w46")).toBeUndefined();
		expect(keyPeriodEnd("phone-vault/2026-w46")).toBeUndefined();
	});
});

describe("vault period keys", () => {
	it("makes the period key in the store under its own name and grants only the vault prefix", async () => {
		const day = keyPeriod(now);
		const key = await ensurePeriodKey(creds.keyDeps(paths), day);

		expect(key.length).toBe(32);
		expect(creds.store.get(vaultKeyName(day))).toBe(key.toString("hex"));
		expect(vaultKeyName(day)).toBe(`phone-vault/${day}`);
		expect(creds.calls).toContain("grant phone-vault");
	});

	it("stores the lowercase week and reads the uppercase spelling as the same key", async () => {
		const period = keyPeriod(now);
		const key = await ensurePeriodKey(creds.keyDeps(paths), period);
		const upper = period.replace("-w", "-W");

		const again = await ensurePeriodKey(creds.keyDeps(paths), upper);

		expect(creds.store.has(`phone-vault/${period}`)).toBe(true);
		expect(creds.store.has(`phone-vault/${upper}`)).toBe(false);
		expect(again.equals(key)).toBe(true);
		expect(creds.calls.filter((call) => call.startsWith("set "))).toHaveLength(1);
	});

	it("reads an existing period key without writing a new one", async () => {
		const day = keyPeriod(now);
		const first = await ensurePeriodKey(creds.keyDeps(paths), day);
		creds.calls.length = 0;

		const second = await ensurePeriodKey(creds.keyDeps(paths), day);

		expect(second.equals(first)).toBe(true);
		expect(creds.calls.some((call) => call.startsWith("set "))).toBe(false);
	});

	it("refuses when the period key is missing and no session can make it", async () => {
		creds.session = false;
		creds.granted = true;

		await expect(ensurePeriodKey(creds.keyDeps(paths), keyPeriod(now))).rejects.toThrow(DgCliError);
		expect(creds.store.size).toBe(0);
	});

	it("refuses when the credential store is not reachable", async () => {
		creds.up = false;

		await expect(ensurePeriodKey(creds.keyDeps(paths), keyPeriod(now))).rejects.toThrow(/not reachable/);
	});

	it("keeps the not-reachable message for connection failures only", async () => {
		for (const message of [
			"not reachable",
			"dg-daemon is not running",
			"no live dg-daemon pid file",
			"cannot connect to dg-daemon",
			"timed out connecting to dg-daemon",
		]) {
			creds.failure = new Error(`prefix ${message} suffix`);
			await expect(ensurePeriodKey(creds.keyDeps(paths), keyPeriod(now))).rejects.toThrow(/not reachable/);
		}
	});

	it("surfaces a name rejection when the store is up, including with no session", async () => {
		creds.session = false;
		creds.granted = true;

		await expect(ensurePeriodKey(creds.keyDeps(paths), "Not A Name")).rejects.toThrow(/credential name must be/);
	});

	it("surfaces the session error when the grant client has no grant", async () => {
		await expect(ensurePeriodKey(creds.keyDeps(paths), "Not A Name")).rejects.toThrow(/credential name must be/);
	});

	it("reports a connection failure while saving the key as not reachable", async () => {
		creds.granted = true;
		creds.beforeSet = async () => {
			throw new Error("cannot connect to dg-daemon on port 1");
		};

		await expect(ensurePeriodKey(creds.keyDeps(paths), keyPeriod(now))).rejects.toThrow(/not reachable/);
	});

	it("refuses when the new key cannot be read back", async () => {
		creds.hideRead = true;

		await expect(ensurePeriodKey(creds.keyDeps(paths), keyPeriod(now))).rejects.toThrow(/no dg session can make it/);
	});

	it("reads an existing key through the session when the grant is gone", async () => {
		const period = keyPeriod(now);
		const key = await ensurePeriodKey(creds.keyDeps(paths), period);
		creds.granted = false;
		creds.calls.length = 0;

		const again = await ensurePeriodKey(creds.keyDeps(paths), period);

		expect(again.equals(key)).toBe(true);
		expect(creds.calls.some((call) => call.startsWith("set "))).toBe(false);
	});

	it("reports a session rejection, and a session connection failure as not reachable", async () => {
		creds.granted = true;
		creds.sessionFailure = new TypeError("credential name must be 1 to 128 letters, digits, dots, underscores, slashes or hyphens, starting with a letter or digit");
		await expect(ensurePeriodKey(creds.keyDeps(paths), keyPeriod(now))).rejects.toThrow(/credential name must be/);

		creds.sessionFailure = new Error("cannot connect to dg-daemon on port 1");
		await expect(ensurePeriodKey(creds.keyDeps(paths), keyPeriod(now))).rejects.toThrow(/not reachable/);
	});

	it("says the store is unreachable when nothing can read it, rather than quoting a missing grant", async () => {
		creds.session = false;

		await expect(ensurePeriodKey(creds.keyDeps(paths), keyPeriod(now))).rejects.toThrow(/not reachable/);
		await expect(ensurePeriodKey(creds.keyDeps(paths), keyPeriod(now))).rejects.not.toThrow(/no credential grant/);
	});

	it("refuses a stored value that is not a vault key", async () => {
		creds.granted = true;
		creds.store.set(vaultKeyName(keyPeriod(now)), "nope");

		await expect(ensurePeriodKey(creds.keyDeps(paths), keyPeriod(now))).rejects.toThrow(/does not hold a vault key/);
	});

	it("makes one key when two processes find it missing at the same time", async () => {
		const day = keyPeriod(now);
		let open: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			open = resolve;
		});
		let sets = 0;
		creds.beforeSet = async () => {
			sets += 1;
			if (sets === 2) await gate;
		};

		const first = ensurePeriodKey(creds.keyDeps(paths), day);
		const second = ensurePeriodKey(creds.keyDeps(paths), day);
		const firstKey = await first;
		open();
		const secondKey = await second;

		expect(secondKey.equals(firstKey)).toBe(true);
		expect(creds.store.get(vaultKeyName(day))).toBe(firstKey.toString("hex"));
		expect(sets).toBe(1);
		expect(existsSync(join(paths.phoneRoot, "vault-key.lock"))).toBe(false);
	});

	it("takes over a key lock left behind by a process that died", async () => {
		mkdirSync(paths.phoneRoot, { recursive: true });
		const lock = join(paths.phoneRoot, "vault-key.lock");
		writeFileSync(lock, "999999");
		const old = new Date(Date.now() - 10 * 60 * 1000);
		utimesSync(lock, old, old);

		const key = await ensurePeriodKey(creds.keyDeps(paths), keyPeriod(now));

		expect(creds.store.get(vaultKeyName(keyPeriod(now)))).toBe(key.toString("hex"));
		expect(existsSync(lock)).toBe(false);
	});

	it("never writes the key to the phone database", async () => {
		const key = await ensurePeriodKey(creds.keyDeps(paths), keyPeriod(now));
		db.close();

		expect(readFileSync(PhoneDb.path(paths)).includes(key.toString("hex"))).toBe(false);
		db = PhoneDb.open(paths, () => now);
	});

	it("keeps a period key until 48 hours after its period ends, then deletes it", async () => {
		const week = at(2026, 11, 4, 12);
		await ensurePeriodKey(creds.keyDeps(paths), keyPeriod(week));
		const name = vaultKeyName(keyPeriod(week));
		const periodEnd = at(2026, 11, 9);

		await dropOldKeys(creds.deps(), periodEnd - 1);
		expect(creds.store.has(name)).toBe(true);
		await dropOldKeys(creds.deps(), periodEnd);
		expect(creds.store.has(name)).toBe(true);
		await dropOldKeys(creds.deps(), periodEnd + 48 * 3600 - 1);
		expect(creds.store.has(name)).toBe(true);
		await dropOldKeys(creds.deps(), periodEnd + 48 * 3600);
		expect(creds.store.has(name)).toBe(false);
	});

	it("deletes only periods past the grace and keeps the last, current, and next", async () => {
		const monday = at(2026, 11, 2, 12);
		for (const offset of [-2, -1, 0, 1]) await ensurePeriodKey(creds.keyDeps(paths), keyPeriod(monday, offset));

		await dropOldKeys(creds.deps(), monday);

		expect([...creds.store.keys()].sort()).toEqual([-1, 0, 1].map((offset) => vaultKeyName(keyPeriod(monday, offset))).sort());
	});

	it("deletes a period key spelled with either week marker", async () => {
		creds.granted = true;
		creds.store.set("phone-vault/2026-W45", "a".repeat(64));
		creds.store.set("phone-vault/2026-w44", "b".repeat(64));

		await dropOldKeys(creds.deps(), at(2026, 11, 16));

		expect(creds.store.has("phone-vault/2026-W45")).toBe(false);
		expect(creds.store.has("phone-vault/2026-w44")).toBe(false);
	});

	it("ignores credential names that are not period keys", async () => {
		creds.store.set("phone-vault/junk", "a".repeat(64));
		creds.store.set("phone-vault/2026-11-04", "a".repeat(64));

		await dropOldKeys(creds.deps(), now);

		expect(creds.store.size).toBe(2);
	});

	it("leaves old keys alone when no session can delete them", async () => {
		await ensurePeriodKey(creds.keyDeps(paths), keyPeriod(now, -3));
		creds.session = false;

		await dropOldKeys(creds.deps(), now);

		expect(creds.store.has(vaultKeyName(keyPeriod(now, -3)))).toBe(true);
	});
});

describe("vault key cache", () => {
	it("has no key before a refresh, then holds this period's and the next period's", async () => {
		const cache = createVaultKeyCache(creds.keyDeps(paths), () => now);
		expect(cache.peek()).toBeUndefined();

		await cache.refresh();

		expect(cache.peek()?.period).toBe(keyPeriod(now));
		expect(creds.store.has(vaultKeyName(keyPeriod(now, 1)))).toBe(true);
	});

	it("makes the next key ahead of time at a period edge, so the new period needs no store call", async () => {
		now = at(2026, 11, 8, 23, 59, 59);
		const cache = createVaultKeyCache(creds.keyDeps(paths), () => now);
		await cache.refresh();
		expect(creds.store.has("phone-vault/2026-w46")).toBe(true);
		const next = creds.store.get("phone-vault/2026-w46");
		creds.up = false;

		now = at(2026, 11, 9);
		const hit = cache.peek();

		expect(hit?.period).toBe("2026-w46");
		expect(hit?.key.toString("hex")).toBe(next);
	});

	it("makes the following keys when the period turns over", async () => {
		now = at(2026, 11, 8, 23, 59, 59);
		const cache = createVaultKeyCache(creds.keyDeps(paths), () => now);
		await cache.refresh();

		now = at(2026, 11, 9);
		await cache.refresh();

		expect(creds.store.has("phone-vault/2026-w47")).toBe(true);
	});

	it("loads the key on demand through current()", async () => {
		const cache = createVaultKeyCache(creds.keyDeps(paths), () => now);

		const key = await cache.current();

		expect(key?.period).toBe(keyPeriod(now));
	});

	it("gives no key when the store cannot make one", async () => {
		creds.session = false;
		const cache = createVaultKeyCache(creds.keyDeps(paths), () => now);

		expect(await cache.current()).toBeUndefined();
	});
});

describe("vault items", () => {
	it("seals an item into a private file named by a random id, never by its name", async () => {
		const plain = Buffer.from("patient Jane Roe, MRN 12345");
		const row = storeVaultItem(db, paths.phoneRoot, { name: "lab", sender: "self", plain, key: await todayKey() }, now);

		expect(row.id).toMatch(/^[0-9a-f]{32}$/);
		expect(readdirSync(vaultDir())).toEqual([row.id]);
		expect(statSync(vaultDir()).mode & 0o777).toBe(0o700);
		expect(statSync(join(vaultDir(), row.id)).mode & 0o777).toBe(0o600);
		expect(readFileSync(join(vaultDir(), row.id)).includes(plain)).toBe(false);
		expect(row).toMatchObject({ name: "lab", sender: "self", size: plain.length, type: "text/plain", created_at: now, expires_at: now + VAULT_TTL_SECONDS });
		expect(db.vaultItem("lab")?.id).toBe(row.id);
	});

	it("opens a sealed item back to its bytes", async () => {
		const plain = Buffer.from("hello vault");
		const row = storeVaultItem(db, paths.phoneRoot, { name: "a", sender: "npub1x", plain, key: await todayKey() }, now);

		expect((await openVaultItem(creds.deps(), paths.phoneRoot, row)).equals(plain)).toBe(true);
	});

	it("refuses to open an item whose sender or expiry changed, since both are bound as AAD", async () => {
		const row = storeVaultItem(db, paths.phoneRoot, { name: "a", sender: "npub1x", plain: Buffer.from("x"), key: await todayKey() }, now);

		await expect(openVaultItem(creds.deps(), paths.phoneRoot, { ...row, sender: "npub1y" })).rejects.toThrow(/cannot be opened/);
		await expect(openVaultItem(creds.deps(), paths.phoneRoot, { ...row, expires_at: row.expires_at + 1 })).rejects.toThrow(/cannot be opened/);
	});

	it("reports a store rejection while opening, and a bad stored key as cannot be opened", async () => {
		const row = storeVaultItem(db, paths.phoneRoot, { name: "a", sender: "self", plain: Buffer.from("x"), key: await todayKey() }, now);
		creds.failure = new TypeError("credential name must be 1 to 128 letters, digits, dots, underscores, slashes or hyphens, starting with a letter or digit");
		await expect(openVaultItem(creds.deps(), paths.phoneRoot, row)).rejects.toThrow(/credential name must be/);
		creds.failure = new DgCliError("credential name must be 1 to 128 letters, digits, dots, underscores, slashes or hyphens, starting with a letter or digit");
		await expect(openVaultItem(creds.deps(), paths.phoneRoot, row)).rejects.toThrow(/credential name must be/);

		creds.failure = new Error("cannot connect to dg-daemon on port 1");
		await expect(openVaultItem(creds.deps(), paths.phoneRoot, row)).rejects.toThrow(/not reachable/);
		creds.failure = new Error("boom");
		await expect(openVaultItem(creds.deps(), paths.phoneRoot, row)).rejects.toThrow(/cannot be opened/);

		creds.failure = undefined;
		creds.granted = true;
		creds.store.set(vaultKeyName(row.key_period), "nope");
		await expect(openVaultItem(creds.deps(), paths.phoneRoot, row)).rejects.toThrow(/cannot be opened/);
	});

	it("cannot open an item once its period key is gone", async () => {
		const row = storeVaultItem(db, paths.phoneRoot, { name: "a", sender: "self", plain: Buffer.from("x"), key: await todayKey() }, now);
		creds.store.clear();

		await expect(openVaultItem(creds.deps(), paths.phoneRoot, row)).rejects.toThrow(DgCliError);
	});

	it("refuses a taken name and leaves no file behind", async () => {
		const key = await todayKey();
		storeVaultItem(db, paths.phoneRoot, { name: "a", sender: "self", plain: Buffer.from("1"), key }, now);

		expect(() => storeVaultItem(db, paths.phoneRoot, { name: "a", sender: "self", plain: Buffer.from("2"), key }, now)).toThrow(/exists/);
		expect(readdirSync(vaultDir()).length).toBe(1);
	});

	it("types an image by its magic bytes and other bytes as binary", async () => {
		const key = await todayKey();
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
		expect(storeVaultItem(db, paths.phoneRoot, { name: "p", sender: "self", plain: png, key }, now).type).toBe("image/png");
		expect(storeVaultItem(db, paths.phoneRoot, { name: "b", sender: "self", plain: Buffer.from([0xff, 0xfe, 0x00]), key }, now).type).toBe(
			"application/octet-stream",
		);
	});

	it("deletes the row and its file", async () => {
		const row = storeVaultItem(db, paths.phoneRoot, { name: "a", sender: "self", plain: Buffer.from("x"), key: await todayKey() }, now);

		deleteVaultItem(db, paths.phoneRoot, row);

		expect(db.vaultItem("a")).toBeUndefined();
		expect(existsSync(join(vaultDir(), row.id))).toBe(false);
	});
});

describe("vault key lifetime", () => {
	it("opens an item sealed in the last second of its period until the item expires", async () => {
		now = at(2026, 11, 8, 23, 59, 59);
		const row = storeVaultItem(db, paths.phoneRoot, { name: "late", sender: "self", plain: Buffer.from("late"), key: await todayKey() }, now);
		expect(row.key_period).toBe("2026-w45");

		for (const t of [now + 1, now + VAULT_TTL_SECONDS - 1]) {
			await dropOldKeys(creds.deps(), t);
			expect((await openVaultItem(creds.deps(), paths.phoneRoot, row)).toString()).toBe("late");
		}
		expect(row.expires_at).toBe(now + VAULT_TTL_SECONDS);
		expect(row.expires_at).toBeLessThan(at(2026, 11, 9) + 48 * 3600);
	});
});

describe("vault expiry", () => {
	it("hides an item at expires_at and prune deletes its row and file", async () => {
		const row = storeVaultItem(db, paths.phoneRoot, { name: "a", sender: "self", plain: Buffer.from("x"), key: await todayKey() }, now);
		now += VAULT_TTL_SECONDS;

		expect(db.vaultItem("a")).toBeUndefined();
		expect(db.listVaultItems()).toEqual([]);
		db.pruneMessages();

		expect(existsSync(join(vaultDir(), row.id))).toBe(false);
		expect(db.vaultNameTaken("a")).toBe(false);
	});

	it("prunes expired items when the database opens", async () => {
		const row = storeVaultItem(db, paths.phoneRoot, { name: "a", sender: "self", plain: Buffer.from("x"), key: await todayKey() }, now);
		db.close();
		now += VAULT_TTL_SECONDS + 1;
		db = PhoneDb.open(paths, () => now);

		expect(existsSync(join(vaultDir(), row.id))).toBe(false);
	});

	it("removes stray files past a short grace, and never follows a symlink", () => {
		mkdirSync(vaultDir(), { recursive: true });
		const stray = join(vaultDir(), "a".repeat(32));
		const fresh = join(vaultDir(), "b".repeat(32));
		const target = join(home, "outside");
		writeFileSync(stray, "x");
		writeFileSync(fresh, "x");
		writeFileSync(target, "keep");
		symlinkSync(target, join(vaultDir(), "c".repeat(32)));
		const old = new Date((now - 120) * 1000);
		utimesSync(stray, old, old);
		utimesSync(fresh, new Date(now * 1000), new Date(now * 1000));

		db.pruneMessages();

		expect(existsSync(stray)).toBe(false);
		expect(existsSync(fresh)).toBe(true);
		expect(readFileSync(target, "utf8")).toBe("keep");
	});

	it("keeps a viewer copy for an hour, then removes it", () => {
		mkdirSync(vaultDir(), { recursive: true });
		const view = join(vaultDir(), `${"d".repeat(32)}.view.png`);
		writeFileSync(view, "x");
		const recent = new Date((now - 600) * 1000);
		utimesSync(view, recent, recent);
		db.pruneMessages();
		expect(existsSync(view)).toBe(true);

		const old = new Date((now - 3601) * 1000);
		utimesSync(view, old, old);
		db.pruneMessages();
		expect(existsSync(view)).toBe(false);
	});
});
