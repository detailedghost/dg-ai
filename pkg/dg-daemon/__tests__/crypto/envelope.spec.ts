import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { buildAad, createCipherBox } from "../../src/crypto/envelope";

const DATA_KEY = randomBytes(32);

function aadFor(rowId: string, sessionId = "session-1") {
	return buildAad({
		domain: "message-body",
		sessionId,
		rowId,
		formatVersion: 1,
	});
}

describe("createCipherBox(dataKey).encryptRecord/decryptRecord", () => {
	it("round-trips plaintext exactly through encrypt then decrypt", () => {
		const box = createCipherBox(DATA_KEY);
		const plaintext = "hello agent — needle-ROUNDTRIP-42";
		const aad = aadFor("row-1");

		const envelope = box.encryptRecord(plaintext, aad);
		const decrypted = box.decryptRecord(
			envelope.ciphertext,
			envelope.iv,
			envelope.tag,
			aad,
		);

		expect(decrypted.toString("utf8")).toBe(plaintext);
	});

	it("exposes encryptRecord as exactly 2-ary — no IV parameter on the public surface", () => {
		const box = createCipherBox(DATA_KEY);
		expect(box.encryptRecord.length).toBe(2);
	});

	it("generates a fresh random IV on every call — never a counter or deterministic IV", () => {
		const box = createCipherBox(DATA_KEY);
		const aad = aadFor("row-2");
		const first = box.encryptRecord("same body", aad);
		const second = box.encryptRecord("same body", aad);

		expect(first.iv.equals(second.iv)).toBe(false);
		expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
	});

	it("defaults to a 12-byte IV", () => {
		const box = createCipherBox(DATA_KEY);
		const envelope = box.encryptRecord("x", aadFor("row-3"));
		expect(envelope.iv.length).toBe(12);
	});

	it("asserts the IV is 12 bytes and refuses a 16-byte IV rather than silently using it — createCipheriv accepts 8/16/32-byte IVs without complaint", () => {
		const box = createCipherBox(DATA_KEY, { randomIv: () => randomBytes(16) });
		expect(() => box.encryptRecord("x", aadFor("row-4"))).toThrow(/12/);
	});

	it("fails loudly on a tampered auth tag rather than returning garbage", () => {
		const box = createCipherBox(DATA_KEY);
		const aad = aadFor("row-5");
		const envelope = box.encryptRecord("secret body", aad);
		const tamperedTag = Buffer.from(envelope.tag);
		tamperedTag[0] ^= 0xff;

		expect(() =>
			box.decryptRecord(envelope.ciphertext, envelope.iv, tamperedTag, aad),
		).toThrow();
	});

	it("fails AAD authentication when a ciphertext is moved to another row's AAD", () => {
		const box = createCipherBox(DATA_KEY);
		const envelope = box.encryptRecord("secret body", aadFor("row-a"));
		const otherRowAad = aadFor("row-b");

		expect(() =>
			box.decryptRecord(
				envelope.ciphertext,
				envelope.iv,
				envelope.tag,
				otherRowAad,
			),
		).toThrow();
	});

	it("refuses to decrypt a stored IV that is not 12 bytes rather than trusting createDecipheriv's leniency", () => {
		const box = createCipherBox(DATA_KEY);
		const aad = aadFor("row-6");
		const envelope = box.encryptRecord("body", aad);
		const truncatedIv = envelope.iv.subarray(0, 8);

		expect(() =>
			box.decryptRecord(envelope.ciphertext, truncatedIv, envelope.tag, aad),
		).toThrow(/12/);
	});
});

describe("buildAad", () => {
	it("binds domain, format version, sessionId and rowId — changing any one changes the AAD", () => {
		const base = buildAad({
			domain: "message-body",
			sessionId: "s1",
			rowId: "r1",
			formatVersion: 1,
		});
		const differentDomain = buildAad({
			domain: "command-argv",
			sessionId: "s1",
			rowId: "r1",
			formatVersion: 1,
		});
		const differentSession = buildAad({
			domain: "message-body",
			sessionId: "s2",
			rowId: "r1",
			formatVersion: 1,
		});
		const differentRow = buildAad({
			domain: "message-body",
			sessionId: "s1",
			rowId: "r2",
			formatVersion: 1,
		});

		expect(base.equals(differentDomain)).toBe(false);
		expect(base.equals(differentSession)).toBe(false);
		expect(base.equals(differentRow)).toBe(false);
	});

	it("is deterministic for the same inputs — needed so a re-derived AAD authenticates the original ciphertext", () => {
		const a = buildAad({
			domain: "message-body",
			sessionId: "s1",
			rowId: "r1",
			formatVersion: 1,
		});
		const b = buildAad({
			domain: "message-body",
			sessionId: "s1",
			rowId: "r1",
			formatVersion: 1,
		});
		expect(a.equals(b)).toBe(true);
	});
});
