import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	mintFallbackKeyFile,
	readFallbackKeyFile,
} from "../../src/crypto/key-file";
import { scratchDir } from "../utils/daemon-harness";

function tempKeyPath(): string {
	return join(scratchDir("dg-key-file"), "key");
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
