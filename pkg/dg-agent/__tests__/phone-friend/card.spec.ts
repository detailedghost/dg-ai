import { describe, expect, it } from "bun:test";
import { DgCliError } from "@dg/common";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { CARD_PREFIX, decodeCard, encodeCard, MAX_CARD_RELAYS } from "../../src/phone-friend/card";

const npub = nip19.npubEncode(getPublicKey(generateSecretKey()));
const card = { npub, relays: ["wss://a.example"], secret: "ab".repeat(32), exp: 2_000 };

function raw(value: unknown): string {
	return CARD_PREFIX + Buffer.from(JSON.stringify(value)).toString("base64url");
}

describe("call cards", () => {
	it("round-trips a card", () => {
		const text = encodeCard(card);

		expect(text).toStartWith(CARD_PREFIX);
		expect(decodeCard(text, 1_000)).toEqual(card);
	});

	it("accepts a relay with a port and a path", () => {
		const withPath = { ...card, relays: ["wss://a.example:4433/nostr"] };

		expect(decodeCard(encodeCard(withPath), 1_000)).toEqual(withPath);
	});

	it("ignores whitespace around a pasted card", () => {
		expect(decodeCard(`  ${encodeCard(card)}\n`, 1_000)).toEqual(card);
	});

	it("rejects an expired card", () => {
		expect(() => decodeCard(encodeCard(card), 2_000)).toThrow("expired");
	});

	it("rejects a card with the wrong prefix", () => {
		expect(() => decodeCard(encodeCard(card).replace(CARD_PREFIX, "nope1"), 1_000)).toThrow(DgCliError);
	});

	it("rejects a card that is not base64 JSON", () => {
		expect(() => decodeCard(`${CARD_PREFIX}%%%`, 1_000)).toThrow(DgCliError);
	});

	it("rejects a tampered card", () => {
		for (const bad of [
			{ ...card, v: 2 },
			{ ...card, v: 1, npub: "npub1nope" },
			{ ...card, v: 1, relays: [] },
			{ ...card, v: 1, relays: ["http://a.example"] },
			{ ...card, v: 1, relays: ["wss://a.example\nINJECTED"] },
			{ ...card, v: 1, relays: ["wss://a.example extra"] },
			{ ...card, v: 1, relays: Array.from({ length: MAX_CARD_RELAYS + 1 }, (_, i) => `wss://r${i}.example`) },
			{ ...card, v: 1, secret: "short" },
			{ ...card, v: 1, exp: "soon" },
		]) {
			expect(() => decodeCard(raw(bad), 1_000)).toThrow(DgCliError);
		}
	});
});
