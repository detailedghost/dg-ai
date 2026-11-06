import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDgPaths } from "@dg/common/node";
import {
	createKeychainBackendForPlatform,
	guardedBackend,
	dpapiBackend,
	keychainAccountFor,
	keychainAccountsForPaths,
	macKeychainBackend,
	RealKeychainInTestError,
	secretToolBackend,
} from "../../src/crypto/keychain-backends";
import type { KeychainBackend } from "../../src/crypto/key-resolution";
import { ChatStore } from "../../src/store";
import { cleanupDgHome, freshDgHome } from "../utils/daemon-harness";
import { type FakeKeychain, fakeKeychain, OTHER_SECRET, SECRET } from "../utils/fake-keychain";

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

describe("createKeychainBackendForPlatform", () => {
	const paths = resolveDgPaths({ platform: "linux", homeDir: HOME, env: {} });
	const accounts = keychainAccountsForPaths(paths, HOME);

	function build(current: FakeKeychain, legacy: FakeKeychain): KeychainBackend {
		const byAccount = new Map([
			[accounts.current, current.backend],
			[accounts.legacy, legacy.backend],
		]);
		const backend = createKeychainBackendForPlatform(paths, {
			platform: "linux",
			backendFor: (account: string) => byAccount.get(account) as KeychainBackend,
		} as never);
		return backend as KeychainBackend;
	}

	it("reads the current account first and never asks the legacy account when the current one holds a key", async () => {
		const current = fakeKeychain(SECRET);
		const legacy = fakeKeychain(OTHER_SECRET);

		expect(await build(current, legacy).lookup()).toEqual({ status: "found", keyBase64: SECRET });
		expect(legacy.calls).toEqual([]);
	});

	it("falls back to the legacy account read-only when the current account is absent", async () => {
		const current = fakeKeychain(undefined);
		const legacy = fakeKeychain(SECRET);

		expect(await build(current, legacy).lookup()).toEqual({ status: "found", keyBase64: SECRET });
		expect(current.count("store") + current.count("remove")).toBe(0);
		expect(legacy.count("store") + legacy.count("remove")).toBe(0);
	});

	it("returns the current key when a concurrent step deletes the legacy entry between the two reads", async () => {
		const current = fakeKeychain(SECRET, { reads: [{ status: "absent" }] });
		const legacy = fakeKeychain(undefined);

		expect(await build(current, legacy).lookup()).toEqual({ status: "found", keyBase64: SECRET });
		expect(current.count("lookup")).toBe(2);
	});

	it("reports absent only when both accounts are absent", async () => {
		expect(await build(fakeKeychain(undefined), fakeKeychain(undefined)).lookup()).toEqual({ status: "absent" });
	});

	it("reports unreachable, not absent, when the current account is absent and the legacy one cannot be read", async () => {
		const legacy = fakeKeychain(undefined, { lookupUnreachable: true });

		expect(await build(fakeKeychain(undefined), legacy).lookup()).toEqual({ status: "unreachable" });
	});

	it("reports unreachable when the current account cannot be read", async () => {
		const current = fakeKeychain(undefined, { lookupUnreachable: true });

		expect(await build(current, fakeKeychain(SECRET)).lookup()).toEqual({ status: "unreachable" });
	});

	it("stores and removes on the current account only", async () => {
		const current = fakeKeychain(undefined);
		const legacy = fakeKeychain(SECRET);
		const backend = build(current, legacy);

		expect(await backend.store(OTHER_SECRET)).toBe("stored");
		expect(await backend.remove?.()).toBe("removed");

		expect(current.calls).toEqual(["store", "remove"]);
		expect(legacy.calls).toEqual([]);
		expect(legacy.value).toBe(SECRET);
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

describe("macKeychainBackend store", () => {
	it("updates an existing entry by passing -U to security", async () => {
		const bin = mkdtempSync(join(tmpdir(), "dg-fake-security-"));
		const out = join(bin, "argv.txt");
		try {
			writeFileSync(join(bin, "security"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${out}"\n`, { mode: 0o755 });
			const script = `import { macKeychainBackend } from ${JSON.stringify(join(import.meta.dir, "../../src/crypto/keychain-backends"))};
process.stdout.write(await macKeychainBackend("acct").store("test-value"));`;
			const { NODE_ENV: _omitted, ...inherited } = process.env;
			const child = Bun.spawn([process.execPath, "-e", script], {
				env: { ...inherited, PATH: bin },
				stdout: "pipe",
				stderr: "pipe",
			});
			const stored = await new Response(child.stdout).text();
			await child.exited;

			expect(stored).toBe("stored");
			const argv = readFileSync(out, "utf8").trim().split("\n");
			expect(argv.slice(0, 2)).toEqual(["add-generic-password", "-U"]);
		} finally {
			rmSync(bin, { recursive: true, force: true });
		}
	});
});

describe("guardedBackend", () => {
	it("maps every rejection to unreachable without carrying the message", async () => {
		const guarded = guardedBackend(fakeKeychain(SECRET, { rejectWith: `boom ${SECRET}` }).backend);

		expect(await guarded.lookup()).toEqual({ status: "unreachable" });
		expect(await guarded.store(SECRET)).toBe("unreachable");
		expect(await guarded.remove?.()).toBe("unreachable");
	});

	it("passes results through when the backend works", async () => {
		const fake = fakeKeychain(undefined);
		const guarded = guardedBackend(fake.backend);

		expect(await guarded.store(SECRET)).toBe("stored");
		expect(await guarded.lookup()).toEqual({ status: "found", keyBase64: SECRET });
		expect(await guarded.remove?.()).toBe("removed");
	});

	it("exposes no remove when the backend has none", () => {
		const { remove: _omitted, ...rest } = fakeKeychain(undefined).backend;

		expect(guardedBackend(rest).remove).toBeUndefined();
	});
});
