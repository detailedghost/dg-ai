import { describe, expect, it } from "bun:test";
import { DgCliError } from "@dg/common";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { CARD_PREFIX, CARD_PREFIX_V1, decodeCard, encodeCard, MAX_CARD_RELAYS } from "../../src/phone-friend/card";
import { DEFAULT_RELAYS } from "../../src/phone-friend/store";

const pubkeyHex = getPublicKey(generateSecretKey());
const npub = nip19.npubEncode(pubkeyHex);
const secretHex = "ab".repeat(32);
const card = { npub, relays: ["wss://a.example"], secret: secretHex, exp: 2_000, handle: "default" };

function rawV2(bytes: Buffer): string {
	return CARD_PREFIX + bytes.toString("base64url");
}

/** Builds a v2 card's raw bytes directly, bypassing `encodeCard`'s own validation, for hostile-input tests. */
function v2Bytes(
	opts: { pubkeyHex?: string; secretHex?: string; exp?: number; relaySection?: Buffer; handle?: string | Buffer } = {},
): Buffer {
	const exp = Buffer.alloc(4);
	exp.writeUInt32BE(opts.exp ?? card.exp, 0);
	const handle =
		opts.handle === undefined
			? Buffer.from("default", "ascii")
			: Buffer.isBuffer(opts.handle)
				? opts.handle
				: Buffer.from(opts.handle, "ascii");
	return Buffer.concat([
		Buffer.from(opts.pubkeyHex ?? pubkeyHex, "hex"),
		Buffer.from(opts.secretHex ?? secretHex, "hex"),
		exp,
		opts.relaySection ?? Buffer.from([0]),
		handle,
	]);
}

describe("call cards v2 (current)", () => {
	it("round-trips a card with a custom relay", () => {
		const text = encodeCard(card);

		expect(text).toStartWith(CARD_PREFIX);
		expect(decodeCard(text, 1_000)).toEqual(card);
	});

	it("round-trips the default relay list as the single relay-set byte", () => {
		const withDefaults = { ...card, relays: DEFAULT_RELAYS };

		expect(decodeCard(encodeCard(withDefaults), 1_000)).toEqual(withDefaults);
	});

	it("stays under ~110 chars with default relays and a short handle", () => {
		const text = encodeCard({ ...card, relays: DEFAULT_RELAYS });

		expect(text.length).toBeLessThanOrEqual(110);
	});

	it("is far shorter than a v1 card with the same contents", () => {
		const v1 = CARD_PREFIX_V1 + Buffer.from(JSON.stringify({ v: 1, ...card })).toString("base64url");
		const v2 = encodeCard({ ...card, relays: DEFAULT_RELAYS });

		expect(v2.length).toBeLessThan(v1.length / 2);
	});

	it("round-trips a relay with a port and a path", () => {
		const withPath = { ...card, relays: ["wss://a.example:4433/nostr"] };

		expect(decodeCard(encodeCard(withPath), 1_000)).toEqual(withPath);
	});

	it("round-trips several relays and the max handle length", () => {
		const withMany = { ...card, relays: ["wss://a.example", "wss://b.example:4433/path"], handle: "a".repeat(32) };

		expect(decodeCard(encodeCard(withMany), 1_000)).toEqual(withMany);
	});

	it("ignores whitespace around a pasted card", () => {
		expect(decodeCard(`  ${encodeCard(card)}\n`, 1_000)).toEqual(card);
	});

	it("rejects an expired card", () => {
		expect(() => decodeCard(encodeCard(card), 3_000)).toThrow("expired");
	});

	it("rejects a handle that is not a safe line name", () => {
		for (const handle of ["", "Default", "de fault", "../etc", "a".repeat(33), "has/slash", "has@at"]) {
			expect(() => encodeCard({ ...card, handle })).toThrow(DgCliError);
		}
	});

	it("rejects a tampered handle even though the rest of the card decodes", () => {
		for (const handle of [Buffer.from("UPPER"), Buffer.from("has space"), Buffer.from("a".repeat(33)), Buffer.alloc(0)]) {
			expect(() => decodeCard(rawV2(v2Bytes({ handle })), 1_000)).toThrow(DgCliError);
		}
	});

	it("rejects characters outside the base64url alphabet", () => {
		const text = encodeCard(card);

		expect(() => decodeCard(`${text.slice(0, 10)}%%${text.slice(12)}`, 1_000)).toThrow(DgCliError);
		expect(() => decodeCard(`${text} extra`, 1_000)).toThrow(DgCliError);
		expect(() => decodeCard(`${text}=`, 1_000)).toThrow(DgCliError);
	});

	it("rejects a truncated card", () => {
		expect(() => decodeCard(rawV2(v2Bytes().subarray(0, 50)), 1_000)).toThrow(DgCliError);
	});

	it("rejects a relay count over the max, or a relay section cut short", () => {
		expect(() => decodeCard(rawV2(v2Bytes({ relaySection: Buffer.from([11]) })), 1_000)).toThrow(DgCliError);
		expect(() => decodeCard(rawV2(v2Bytes({ relaySection: Buffer.from([1, 200]) })), 1_000)).toThrow(DgCliError);
	});

	it("rejects a relay that decodes but is not a wss:// URL", () => {
		const relay = Buffer.from("http://nope", "utf8");
		const relaySection = Buffer.concat([Buffer.from([1, relay.length]), relay]);

		expect(() => decodeCard(rawV2(v2Bytes({ relaySection })), 1_000)).toThrow(DgCliError);
	});

	it("rejects a card with the wrong prefix", () => {
		expect(() => decodeCard(encodeCard(card).replace(CARD_PREFIX, "nope1"), 1_000)).toThrow(DgCliError);
	});

	it("refuses to encode a relay url too long for the one-byte length prefix", () => {
		const huge = `wss://${"a".repeat(260)}.example`;

		expect(() => encodeCard({ ...card, relays: [huge] })).toThrow(DgCliError);
	});

	it("refuses to encode more than the max relays", () => {
		const tooMany = Array.from({ length: MAX_CARD_RELAYS + 1 }, (_, i) => `wss://r${i}.example`);

		expect(() => decodeCard(encodeCard({ ...card, relays: tooMany }), 1_000)).toThrow(DgCliError);
	});
});

describe("call cards v1 (legacy, dial only)", () => {
	function rawV1(value: unknown): string {
		return CARD_PREFIX_V1 + Buffer.from(JSON.stringify(value)).toString("base64url");
	}
	const v1Card = { v: 1, npub, relays: ["wss://a.example"], secret: secretHex, exp: 2_000 };

	it("a card `invite` printed before this change still dials", () => {
		expect(decodeCard(rawV1(v1Card), 1_000)).toEqual({
			npub,
			relays: ["wss://a.example"],
			secret: secretHex,
			exp: 2_000,
		});
	});

	it("rejects an expired v1 card", () => {
		expect(() => decodeCard(rawV1(v1Card), 2_000)).toThrow("expired");
	});

	it("rejects a tampered v1 card", () => {
		for (const bad of [
			{ ...v1Card, v: 2 },
			{ ...v1Card, npub: "npub1nope" },
			{ ...v1Card, relays: [] },
			{ ...v1Card, relays: ["http://a.example"] },
			{ ...v1Card, relays: Array.from({ length: MAX_CARD_RELAYS + 1 }, (_, i) => `wss://r${i}.example`) },
			{ ...v1Card, secret: "short" },
			{ ...v1Card, exp: "soon" },
		]) {
			expect(() => decodeCard(rawV1(bad), 1_000)).toThrow(DgCliError);
		}
	});

	it("rejects a v1 card that is not base64 JSON", () => {
		expect(() => decodeCard(`${CARD_PREFIX_V1}%%%`, 1_000)).toThrow(DgCliError);
	});
});

describe("call cards, either version", () => {
	it("rejects text with neither card prefix", () => {
		expect(() => decodeCard("not-a-card", 1_000)).toThrow(DgCliError);
		expect(() => decodeCard("", 1_000)).toThrow(DgCliError);
	});
});
