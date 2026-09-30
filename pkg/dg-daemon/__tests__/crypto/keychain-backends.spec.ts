import { describe, expect, it } from "bun:test";
import { resolveDgPaths } from "@dg/common/node";
import {
	createKeychainBackendForPlatform,
	dpapiBackend,
	keychainAccountFor,
	macKeychainBackend,
	RealKeychainInTestError,
	secretToolBackend,
} from "../../src/crypto/keychain-backends";
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
