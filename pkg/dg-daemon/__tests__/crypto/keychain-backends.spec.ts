import { describe, expect, it } from "bun:test";
import { resolveDgPaths } from "@dg/common/node";
import {
	createKeychainBackendForPlatform,
	dpapiBackend,
	keychainAccountFor,
	keychainAccountsForPaths,
	macKeychainBackend,
	migratingKeychainBackend,
	RealKeychainInTestError,
	secretToolBackend,
} from "../../src/crypto/keychain-backends";
import type { KeychainBackend, KeychainLookupResult } from "../../src/crypto/key-resolution";
import { ChatStore } from "../../src/store";
import { cleanupDgHome, freshDgHome } from "../utils/daemon-harness";

const HOME = "/home/someone";

describe("keychainAccountFor", () => {
	it("keeps the legacy account name for the default home so the existing entry is still found", () => {
		expect(keychainAccountFor(`${HOME}/.dg`, HOME)).toBe("chat-store-kek");
		expect(keychainAccountFor(`${HOME}/.dg/`, HOME)).toBe("chat-store-kek");
	});

	it("scopes every other state dir to its own account", () => {
		const a = keychainAccountFor("/tmp/dg-a", HOME);
		const b = keychainAccountFor("/tmp/dg-b", HOME);

		expect(a).toMatch(/^chat-store-kek:[0-9a-f]{12}$/);
		expect(b).toMatch(/^chat-store-kek:[0-9a-f]{12}$/);
		expect(a).not.toBe(b);
		expect(a).toBe(keychainAccountFor("/tmp/dg-a/", HOME));
	});
});

describe("keychainAccountsForPaths", () => {
	it("names the new account after the state root and the old one after the old flat home", () => {
		const paths = resolveDgPaths({ platform: "linux", homeDir: HOME, env: {} });

		expect(keychainAccountsForPaths(paths, HOME)).toEqual({
			current: keychainAccountFor(paths.stateDir, HOME),
			legacy: "chat-store-kek",
		});
	});

	it("scopes a DG_HOME install by its state folder now and by DG_HOME before", () => {
		const paths = resolveDgPaths({ platform: "linux", homeDir: HOME, env: { DG_HOME: "/tmp/dg-a" } });

		expect(keychainAccountsForPaths(paths, HOME)).toEqual({
			current: keychainAccountFor("/tmp/dg-a/state", HOME),
			legacy: keychainAccountFor("/tmp/dg-a", HOME),
		});
	});
});

const SECRET = Buffer.from("secret-key-encryption-key-32bytes").toString("base64");

type Fake = { value?: string; removed: number; backend: KeychainBackend };

function fakeKeychain(
	value: string | undefined,
	opts: { storeFails?: boolean; storeAs?: string; removeFails?: boolean } = {},
): Fake {
	const fake: Fake = {
		value,
		removed: 0,
		backend: {
			async lookup(): Promise<KeychainLookupResult> {
				return fake.value === undefined ? { status: "absent" } : { status: "found", keyBase64: fake.value };
			},
			async store(keyBase64) {
				if (opts.storeFails) return "unreachable";
				fake.value = opts.storeAs ?? keyBase64;
				return "stored";
			},
			async remove() {
				if (opts.removeFails) return "unreachable";
				fake.value = undefined;
				fake.removed += 1;
				return "removed";
			},
		},
	};
	return fake;
}

describe("migratingKeychainBackend", () => {
	function open(current: Fake, legacy: Fake) {
		const warnings: string[] = [];
		const backend = migratingKeychainBackend(current.backend, legacy.backend, (line) => warnings.push(line));
		return { backend, warnings };
	}

	it("copies the old entry to the new account, checks it, then deletes the old entry", async () => {
		const current = fakeKeychain(undefined);
		const legacy = fakeKeychain(SECRET);
		const { backend, warnings } = open(current, legacy);

		expect(await backend.lookup()).toEqual({ status: "found", keyBase64: SECRET });
		expect(current.value).toBe(SECRET);
		expect(legacy.value).toBeUndefined();
		expect(warnings).toEqual([]);
	});

	it("keeps the old entry and reads from it when the new account cannot be written", async () => {
		const current = fakeKeychain(undefined, { storeFails: true });
		const legacy = fakeKeychain(SECRET);
		const { backend, warnings } = open(current, legacy);

		expect(await backend.lookup()).toEqual({ status: "found", keyBase64: SECRET });
		expect(await backend.lookup()).toEqual({ status: "found", keyBase64: SECRET });
		expect(legacy.value).toBe(SECRET);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("chat-store-kek");
		expect(warnings[0]).not.toContain(SECRET);
	});

	it("keeps the old entry when the new entry reads back different", async () => {
		const current = fakeKeychain(undefined, { storeAs: "bWFuZ2xlZA==" });
		const legacy = fakeKeychain(SECRET);
		const { backend, warnings } = open(current, legacy);

		expect(await backend.lookup()).toEqual({ status: "found", keyBase64: SECRET });
		expect(legacy.value).toBe(SECRET);
		expect(legacy.removed).toBe(0);
		expect(warnings).toHaveLength(1);
		expect(warnings.join("")).not.toContain(SECRET);
	});

	it("finishes a move whose old entry could not be deleted the last time", async () => {
		const current = fakeKeychain(SECRET);
		const legacy = fakeKeychain(SECRET);
		const { backend, warnings } = open(current, legacy);

		expect(await backend.lookup()).toEqual({ status: "found", keyBase64: SECRET });
		expect(legacy.value).toBeUndefined();
		expect(warnings).toEqual([]);
	});

	it("warns once and keeps the old entry when it cannot be deleted", async () => {
		const current = fakeKeychain(undefined);
		const legacy = fakeKeychain(SECRET, { removeFails: true });
		const { backend, warnings } = open(current, legacy);

		expect(await backend.lookup()).toEqual({ status: "found", keyBase64: SECRET });
		expect(current.value).toBe(SECRET);
		expect(legacy.value).toBe(SECRET);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).not.toContain(SECRET);
	});

	it("reports unreachable, not absent, when the new account is empty and the old one cannot be read", async () => {
		const current = fakeKeychain(undefined);
		const legacy: KeychainBackend = {
			lookup: async () => ({ status: "unreachable" }),
			store: async () => "unreachable",
		};
		const warnings: string[] = [];
		const backend = migratingKeychainBackend(current.backend, legacy, (line) => warnings.push(line));

		expect(await backend.lookup()).toEqual({ status: "unreachable" });
		expect(current.value).toBeUndefined();
	});

	it("reads only the new account when there is no old entry and stores new keys there", async () => {
		const current = fakeKeychain(undefined);
		const legacy = fakeKeychain(undefined);
		const { backend } = open(current, legacy);

		expect(await backend.lookup()).toEqual({ status: "absent" });
		expect(await backend.store(SECRET)).toBe("stored");
		expect(current.value).toBe(SECRET);
		expect(legacy.value).toBeUndefined();
	});
});

describe("test-run guard for the real keychain backends", () => {
	it.each([
		["secret-tool", () => secretToolBackend("chat-store-kek")],
		["security", () => macKeychainBackend("chat-store-kek")],
		["powershell", () => dpapiBackend("/tmp/key.dpapi")],
	])("refuses to build the %s backend", (_name, build) => {
		expect(build).toThrow(RealKeychainInTestError);
	});

	it("refuses the platform default backend", () => {
		const paths = resolveDgPaths({ env: { DG_HOME: "/tmp/dg-guard" } });

		expect(() => createKeychainBackendForPlatform(paths)).toThrow(
			RealKeychainInTestError,
		);
	});

	it("fails a store opened without a fake backend or DG_KEY_SOURCE=file", async () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });

			await expect(ChatStore.open(paths, { env: {} })).rejects.toThrow(
				RealKeychainInTestError,
			);
		} finally {
			cleanupDgHome(dgHome);
		}
	});
});
