import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DgCliError } from "@dg/common";
import {
	credentialGrantTokenPath,
	type DgPaths,
	DaemonNotRunningError,
	resolveDgPaths,
	writeCredentialGrantToken,
} from "@dg/common/node";
import { nip19 } from "nostr-tools";
import { ensureKey, GRANT_PREFIX, KEY_NAME, type KeyClient, type KeyDeps, loadKey } from "../../src/phone-friend/keys";
import { loadOrCreateKey } from "../../src/phone-friend/store";

let home: string;
let paths: DgPaths;
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
		sessionClient: async () => (options.session && daemonUp ? client(options.client) : undefined),
		grantClient: () => client(options.client),
	};
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "dg-phone-friend-keys-"));
	paths = resolveDgPaths({ env: { DG_HOME: home } });
	store = new Map();
	daemonUp = true;
	calls = [];
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("ensureKey", () => {
	it("puts the first key in the store and makes a grant when a session exists", async () => {
		const { sk, mode } = await ensureKey(deps({ session: true }));

		expect(mode).toBe("store");
		expect(store.get(KEY_NAME)).toBe(nip19.nsecEncode(sk));
		expect(existsSync(credentialGrantTokenPath(paths, GRANT_PREFIX))).toBe(true);
		expect(existsSync(paths.phoneFriendKeyPath)).toBe(false);
	});

	it("writes a 0600 key file when no session exists", async () => {
		const { mode } = await ensureKey(deps());

		expect(mode).toBe("file");
		expect(statSync(paths.phoneFriendKeyPath).mode & 0o777).toBe(0o600);
		expect(store.size).toBe(0);
	});

	it("moves a file key to the store and deletes the file after a matching read-back", async () => {
		const original = loadOrCreateKey(paths);

		const { sk, mode } = await ensureKey(deps({ session: true }));

		expect(mode).toBe("store");
		expect(Buffer.from(sk).equals(Buffer.from(original))).toBe(true);
		expect(store.get(KEY_NAME)).toBe(nip19.nsecEncode(original));
		expect(existsSync(paths.phoneFriendKeyPath)).toBe(false);
		expect(calls).toEqual([`set ${KEY_NAME}`, `grant ${GRANT_PREFIX}`, `get ${KEY_NAME}`]);
	});

	it("keeps the file when the read-back does not match", async () => {
		const original = loadOrCreateKey(paths);

		const { sk, mode } = await ensureKey(
			deps({ session: true, client: { get: async () => ({ value: "nsec1wrong", meta: {}, updatedAt: "" }) } }),
		);

		expect(mode).toBe("file");
		expect(Buffer.from(sk).equals(Buffer.from(original))).toBe(true);
		expect(existsSync(paths.phoneFriendKeyPath)).toBe(true);
	});

	it("keeps the file when the store refuses the write", async () => {
		loadOrCreateKey(paths);

		const { mode } = await ensureKey(
			deps({ session: true, client: { set: async () => { throw new DgCliError("refused"); } } }),
		);

		expect(mode).toBe("file");
		expect(existsSync(paths.phoneFriendKeyPath)).toBe(true);
	});

	it("reuses the store key and never makes a second one", async () => {
		const first = await ensureKey(deps({ session: true }));
		const second = await ensureKey(deps({ session: true }));

		expect(Buffer.from(second.sk).equals(Buffer.from(first.sk))).toBe(true);
		expect(calls.filter((call) => call.startsWith("set"))).toHaveLength(1);
	});

	it("fails in store mode with the daemon down, and makes no new key", async () => {
		await ensureKey(deps({ session: true }));
		daemonUp = false;

		await expect(ensureKey(deps({ session: true }))).rejects.toThrow("not reachable");

		expect(existsSync(paths.phoneFriendKeyPath)).toBe(false);
	});
});

describe("loadKey", () => {
	it("returns undefined before any key exists", async () => {
		expect(await loadKey(deps())).toBeUndefined();
	});

	it("reads a store key through the grant client", async () => {
		const made = await ensureKey(deps({ session: true }));
		calls = [];

		const loaded = await loadKey(deps());

		expect(loaded?.mode).toBe("store");
		expect(Buffer.from(loaded?.sk ?? []).equals(Buffer.from(made.sk))).toBe(true);
		expect(calls).toEqual([`get ${KEY_NAME}`]);
	});

	it("fails when the grant exists but the store has no key", async () => {
		writeCredentialGrantToken(paths, GRANT_PREFIX, "t".repeat(64));

		await expect(loadKey(deps())).rejects.toBeInstanceOf(DgCliError);
	});

	it("never puts the stored value in an error", async () => {
		writeCredentialGrantToken(paths, GRANT_PREFIX, "t".repeat(64));
		store.set(KEY_NAME, "nsec1notarealkeybutsecret");

		const failure = loadKey(deps());

		await expect(failure).rejects.toBeInstanceOf(DgCliError);
		await expect(failure).rejects.not.toThrow("nsec1notarealkeybutsecret");
	});

	it("reads a file key without a daemon", async () => {
		daemonUp = false;
		loadOrCreateKey(paths);

		expect((await loadKey(deps()))?.mode).toBe("file");
		expect(readFileSync(paths.phoneFriendKeyPath, "utf8")).toStartWith("nsec1");
	});
});
