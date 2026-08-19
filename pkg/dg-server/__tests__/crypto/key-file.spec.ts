/**
 * Fallback key file: O_CREAT|O_EXCL at 0600, EEXIST is a re-read (never an
 * overwrite), and every read fstat-and-refuses a file whose mode has drifted
 * from 0600 — writeFileSync's mode option does not fix an EXISTING file's
 * mode, so this can't be tested by asserting the write call alone.
 */
import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	mintFallbackKeyFile,
	readFallbackKeyFile,
} from "../../src/crypto/key-file";

function tempKeyPath(): string {
	return join(mkdtempSync(join(tmpdir(), "dg-key-file-test-")), "key");
}

describe("mintFallbackKeyFile", () => {
	it("writes the KEK base64-encoded alongside its keyId and formatVersion, mode 0600", () => {
		const keyPath = tempKeyPath();
		const kek = randomBytes(32);

		const written = mintFallbackKeyFile(keyPath, kek, "fingerprint-a");

		expect(written.keyBase64).toBe(kek.toString("base64"));
		expect(written.keyId).toBe("fingerprint-a");
		expect(typeof written.formatVersion).toBe("number");
		expect(statSync(keyPath).mode & 0o777).toBe(0o600);
	});

	it("treats an existing file (EEXIST) as a re-read, never an overwrite", () => {
		const keyPath = tempKeyPath();
		const originalKek = randomBytes(32);
		mintFallbackKeyFile(keyPath, originalKek, "original-id");
		const rawBefore = readFileSync(keyPath, "utf8");

		const second = mintFallbackKeyFile(keyPath, randomBytes(32), "clobber-id");

		expect(second.keyId).toBe("original-id");
		expect(second.keyBase64).toBe(originalKek.toString("base64"));
		expect(readFileSync(keyPath, "utf8")).toBe(rawBefore);
	});
});

describe("readFallbackKeyFile", () => {
	it("returns the minted key's fields unchanged when the mode is still 0600", () => {
		const keyPath = tempKeyPath();
		const kek = randomBytes(32);
		mintFallbackKeyFile(keyPath, kek, "fingerprint-b");

		const read = readFallbackKeyFile(keyPath);

		expect(read.keyBase64).toBe(kek.toString("base64"));
		expect(read.keyId).toBe("fingerprint-b");
	});

	it("refuses to read a key file whose mode has drifted from 0600", () => {
		const keyPath = tempKeyPath();
		mintFallbackKeyFile(keyPath, randomBytes(32), "fingerprint-c");
		chmodSync(keyPath, 0o644);

		expect(() => readFallbackKeyFile(keyPath)).toThrow();
	});
});
