/**
 * Identity-first key resolution: read crypto_meta.key_id, collect candidates
 * from every source that answers, use the one whose fingerprint matches, and
 * REFUSE TO START when none matches. Mint (and WRITE into the keychain when
 * reachable) only when no crypto_meta row exists yet.
 *
 * Every keychain interaction here goes through an injected KeychainBackend
 * fake — this suite must never read or write the developer's real login
 * keyring (Testing Criteria). DG_KEY_SOURCE selection is exercised via the
 * `mode` field directly; the env-var-to-mode wiring itself is covered at the
 * store level in __tests__/store/key-resolution-startup.spec.ts.
 *
 * [SPEC] ASSUMED: resolveDataKey's `mode` gates which sources are even
 * PROBED (mode:"file" never calls the keychain backend at all) — this is
 * what lets an operator set DG_KEY_SOURCE=file to sidestep the macOS
 * `security` GUI-ACL-prompt hazard under a detached daemon, per the
 * Engineering bullet naming that hazard.
 */
import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	CryptoMetaRow,
	KeychainBackend,
	KeychainLookupResult,
} from "../../src/crypto/key-resolution";
import {
	fingerprintKey,
	KeyResolutionRefusedError,
	resolveDataKey,
	unwrapDataKey,
	wrapDataKey,
} from "../../src/crypto/key-resolution";

function tempKeyPath(): string {
	return join(mkdtempSync(join(tmpdir(), "dg-key-resolution-test-")), "key");
}

/** A KeychainBackend fake whose lookup/store are pre-programmed and call-counted — never touches a real keyring. */
function fakeKeychain(
	lookup: KeychainLookupResult,
	storeResult: "stored" | "unreachable" = "stored",
): KeychainBackend & { lookupCalls: number; storeCalls: string[] } {
	return {
		lookupCalls: 0,
		storeCalls: [],
		async lookup() {
			this.lookupCalls++;
			return lookup;
		},
		async store(keyBase64: string) {
			this.storeCalls.push(keyBase64);
			return storeResult;
		},
	};
}

describe("fingerprintKey", () => {
	it("is deterministic and non-secret-derived — same KEK always yields the same id", () => {
		const kek = randomBytes(32);
		expect(fingerprintKey(kek)).toBe(fingerprintKey(kek));
	});

	it("differs for different KEKs", () => {
		expect(fingerprintKey(randomBytes(32))).not.toBe(
			fingerprintKey(randomBytes(32)),
		);
	});
});

describe("wrapDataKey / unwrapDataKey", () => {
	it("round-trips the raw data key through wrap then unwrap", () => {
		const kek = randomBytes(32);
		const dataKey = randomBytes(32);
		const wrapped = wrapDataKey(kek, dataKey);
		expect(unwrapDataKey(kek, wrapped).equals(dataKey)).toBe(true);
	});

	it("refuses to unwrap with the wrong KEK", () => {
		const dataKey = randomBytes(32);
		const wrapped = wrapDataKey(randomBytes(32), dataKey);
		expect(() => unwrapDataKey(randomBytes(32), wrapped)).toThrow();
	});
});

describe("resolveDataKey — fresh init (no crypto_meta row)", () => {
	it("mints a 32-byte data key using the file source when mode is 'file', and never touches the keychain", async () => {
		const keychain = fakeKeychain({ status: "absent" });
		const result = await resolveDataKey({
			existing: undefined,
			keyPath: tempKeyPath(),
			mode: "file",
			keychain,
		});

		expect(result.minted).toBe(true);
		expect(result.dataKey.length).toBe(32);
		expect(result.cryptoMeta.keySource).toBe("file");
		expect(keychain.lookupCalls).toBe(0);
		expect(keychain.storeCalls.length).toBe(0);
	});

	it("mints via the keychain and WRITES the KEK into it when mode is 'keychain' and the keychain is reachable", async () => {
		const keychain = fakeKeychain({ status: "absent" }, "stored");
		const result = await resolveDataKey({
			existing: undefined,
			keyPath: tempKeyPath(),
			mode: "keychain",
			keychain,
		});

		expect(result.cryptoMeta.keySource).toBe("keychain");
		expect(keychain.storeCalls.length).toBe(1);
		// The written value must itself be a real 32-byte KEK, not a placeholder.
		expect(Buffer.from(keychain.storeCalls[0], "base64").length).toBe(32);
	});

	it("in 'auto' mode, falls back to the file source with a warning when the keychain is unreachable", async () => {
		const keychain = fakeKeychain({ status: "unreachable" });
		const result = await resolveDataKey({
			existing: undefined,
			keyPath: tempKeyPath(),
			mode: "auto",
			keychain,
		});

		expect(result.cryptoMeta.keySource).toBe("file");
		expect(result.warnings.some((w) => /keychain/i.test(w))).toBe(true);
	});
});

describe("resolveDataKey — existing crypto_meta row", () => {
	it("resolves and unwraps the data key when the recorded fingerprint matches the file KEK", async () => {
		const kek = randomBytes(32);
		const dataKey = randomBytes(32);
		const keyPath = tempKeyPath();
		const { mintFallbackKeyFile } = await import("../../src/crypto/key-file");
		mintFallbackKeyFile(keyPath, kek, fingerprintKey(kek));

		const existing: CryptoMetaRow = {
			formatVersion: 1,
			keyId: fingerprintKey(kek),
			keySource: "file",
			wrappedDataKey: wrapDataKey(kek, dataKey),
		};

		const result = await resolveDataKey({ existing, keyPath, mode: "auto" });

		expect(result.minted).toBe(false);
		expect(result.dataKey.equals(dataKey)).toBe(true);
	});

	it("REFUSES to start when the recorded key_id matches no resolvable candidate, naming recorded vs. resolved identity", async () => {
		const recordedKek = randomBytes(32);
		const unrelatedKek = randomBytes(32);
		const keyPath = tempKeyPath();
		const { mintFallbackKeyFile } = await import("../../src/crypto/key-file");
		// The file on disk holds a DIFFERENT key than the one crypto_meta recorded.
		mintFallbackKeyFile(keyPath, unrelatedKek, fingerprintKey(unrelatedKek));

		const existing: CryptoMetaRow = {
			formatVersion: 1,
			keyId: fingerprintKey(recordedKek),
			keySource: "file",
			wrappedDataKey: wrapDataKey(recordedKek, randomBytes(32)),
		};

		const attempt = resolveDataKey({ existing, keyPath, mode: "auto" });
		await expect(attempt).rejects.toThrow(KeyResolutionRefusedError);
		await attempt.catch((err: unknown) => {
			const refusal = err as InstanceType<typeof KeyResolutionRefusedError>;
			expect(refusal.recordedKeyId).toBe(fingerprintKey(recordedKek));
			expect(refusal.recordedSource).toBe("file");
		});
	});

	it("does not mistake an unreachable keychain for an absent one — the refusal names it distinctly", async () => {
		const recordedKek = randomBytes(32);
		const keychain = fakeKeychain({ status: "unreachable" });
		const keyPath = tempKeyPath(); // no file present at all — genuinely absent on that side

		const existing: CryptoMetaRow = {
			formatVersion: 1,
			keyId: fingerprintKey(recordedKek),
			keySource: "keychain",
			wrappedDataKey: wrapDataKey(recordedKek, randomBytes(32)),
		};

		const attempt = resolveDataKey({
			existing,
			keyPath,
			mode: "auto",
			keychain,
		});
		await expect(attempt).rejects.toThrow(KeyResolutionRefusedError);
		await attempt.catch((err: unknown) => {
			const refusal = err as InstanceType<typeof KeyResolutionRefusedError>;
			const keychainCandidate = refusal.candidates.find(
				(c) => c.source === "keychain",
			);
			expect(keychainCandidate?.status).toBe("unreachable");
			expect(keychainCandidate?.status).not.toBe("absent");
		});
	});

	it("mode:'file' skips probing the keychain entirely, even when the recorded source is 'keychain' — sidesteps the macOS GUI-ACL-prompt hazard", async () => {
		const recordedKek = randomBytes(32);
		const keychain = fakeKeychain({
			status: "found",
			keyBase64: recordedKek.toString("base64"),
		});
		const keyPath = tempKeyPath(); // file has nothing — resolution will fail, but that's not what's under test here

		const existing: CryptoMetaRow = {
			formatVersion: 1,
			keyId: fingerprintKey(recordedKek),
			keySource: "keychain",
			wrappedDataKey: wrapDataKey(recordedKek, randomBytes(32)),
		};

		await resolveDataKey({
			existing,
			keyPath,
			mode: "file",
			keychain,
		}).catch(() => {
			// Refusal is expected (file alone can't match a keychain-recorded key) —
			// the point of this test is solely that the keychain was never asked.
		});

		expect(keychain.lookupCalls).toBe(0);
	});
});
