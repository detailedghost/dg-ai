import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
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
import { generateSecretKey, nip19 } from "nostr-tools";
import { ensureKey, GRANT_PREFIX, type KeyClient, type KeyDeps, keyName, loadKey } from "../../src/phone-friend/keys";
import { type LinePaths, linePaths } from "../../src/phone-friend/line";
import { createFileKey, markKeyInStore, readFileKey } from "../../src/phone-friend/store";

let home: string;
let paths: DgPaths;
let line: LinePaths;
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
		line,
		sessionClient: async () => (options.session && daemonUp ? client(options.client) : undefined),
		grantClient: () => client(options.client),
	};
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "dg-phone-friend-keys-"));
	paths = resolveDgPaths({ env: { DG_HOME: home } });
	line = linePaths(paths);
	KEY_NAME = keyName(line);
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
		expect(readFileKey(line)).toBeUndefined();
	});

	it("keeps the key in the 0600 line database when no session exists", async () => {
		const { mode } = await ensureKey(deps());

		expect(mode).toBe("file");
		expect(readFileKey(line)).toBeDefined();
		expect(statSync(line.dbPath).mode & 0o777).toBe(0o600);
		expect(store.size).toBe(0);
	});

	it("moves a file key to the store and drops the file copy after a matching read-back", async () => {
		const original = createFileKey(line) as Uint8Array;

		const { sk, mode } = await ensureKey(deps({ session: true }));

		expect(mode).toBe("store");
		expect(Buffer.from(sk).equals(Buffer.from(original))).toBe(true);
		expect(store.get(KEY_NAME)).toBe(nip19.nsecEncode(original));
		expect(readFileKey(line)).toBeUndefined();
		expect(calls).toEqual([`set ${KEY_NAME}`, `grant ${GRANT_PREFIX}`, `get ${KEY_NAME}`]);
	});

	it("keeps the file key when the read-back does not match", async () => {
		const original = createFileKey(line) as Uint8Array;

		const { sk, mode } = await ensureKey(
			deps({ session: true, client: { get: async () => ({ value: "nsec1wrong", meta: {}, updatedAt: "" }) } }),
		);

		expect(mode).toBe("file");
		expect(Buffer.from(sk).equals(Buffer.from(original))).toBe(true);
		expect(readFileKey(line)).toBeDefined();
	});

	it("keeps the file key when the store refuses the write", async () => {
		createFileKey(line);

		const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			const { mode } = await ensureKey(
				deps({ session: true, client: { set: async () => { throw new DgCliError("refused"); } } }),
			);

			expect(mode).toBe("file");
			expect(String(stderr.mock.calls[0]?.[0])).toContain("did not take the key");
			expect(String(stderr.mock.calls[0]?.[0])).toContain("refused");
		} finally {
			stderr.mockRestore();
		}
		expect(readFileKey(line)).toBeDefined();
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
						markKeyInStore(line, winner);
					},
				},
			}),
		);

		expect(mode).toBe("store");
		expect(Buffer.from(sk).equals(Buffer.from(winner))).toBe(true);
		expect(readFileKey(line)).toBeUndefined();
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

		expect(readFileKey(line)).toBeUndefined();
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

	it("fails when the line is in store mode but the store has no key", async () => {
		markKeyInStore(line, generateSecretKey());

		await expect(loadKey(deps())).rejects.toBeInstanceOf(DgCliError);
	});

	it("never puts the stored value in an error", async () => {
		markKeyInStore(line, generateSecretKey());
		store.set(KEY_NAME, "nsec1notarealkeybutsecret");

		const failure = loadKey(deps());

		await expect(failure).rejects.toBeInstanceOf(DgCliError);
		await expect(failure).rejects.not.toThrow("nsec1notarealkeybutsecret");
	});

	it("reads a file key without a daemon", async () => {
		daemonUp = false;
		createFileKey(line);

		expect((await loadKey(deps()))?.mode).toBe("file");
	});
});

describe("lines", () => {
	it("gives each line its own key and its own store name", async () => {
		const work = linePaths(paths, "work");
		const first = await ensureKey(deps({ session: true }));
		const second = await ensureKey({ ...deps({ session: true }), line: work });

		expect(Buffer.from(first.sk).equals(Buffer.from(second.sk))).toBe(false);
		expect(store.get(keyName(work))).toBe(nip19.nsecEncode(second.sk));
		expect(keyName(work)).toBe("phone-friend/work/nostr-key");
	});
});
