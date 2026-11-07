import { describe, expect, it } from "bun:test";
import {
	CHAT_PAIR_CLAIM_PATH,
	CHAT_PAIR_OFFER_PATH,
	PAIR_CODE_PATTERN,
	type PairOfferStatus,
	validatePairClaimRequest,
	validatePairOffer,
	validatePairOfferStatus,
} from "../src/index";

const bootstrap = {
	port: 47823,
	sessionId: "session-a",
	token: "token-a",
	agentIdentity: "claude",
};

describe("pairing wire paths", () => {
	it("names the offer and claim routes", () => {
		expect(CHAT_PAIR_OFFER_PATH).toBe("/pair/offer");
		expect(CHAT_PAIR_CLAIM_PATH).toBe("/pair/claim");
	});
});

describe("PAIR_CODE_PATTERN", () => {
	it.each(["000000", "004219", "999999"])("accepts %s", (code) => {
		expect(PAIR_CODE_PATTERN.test(code)).toBe(true);
	});

	it.each(["", "4219", "1234567", "12345a", " 12345", "12345\n"])(
		"rejects %p",
		(code) => {
			expect(PAIR_CODE_PATTERN.test(code)).toBe(false);
		},
	);
});

describe("validatePairOffer", () => {
	const offer = {
		offerId: "7f0c2a52-8b0e-4f43-b8b0-0b8f6f0f0f0f",
		code: "004219",
		expiresAt: 1_700_000_300_000,
	};

	it("accepts a complete offer", () => {
		expect(validatePairOffer(offer)).toEqual(offer);
	});

	it.each([
		["a missing offerId", { ...offer, offerId: undefined }],
		["a short code", { ...offer, code: "4219" }],
		["a numeric code", { ...offer, code: 4219 }],
		["a string expiresAt", { ...offer, expiresAt: "soon" }],
		["a missing expiresAt", { ...offer, expiresAt: undefined }],
		["null", null],
	])("rejects %s", (_name, value) => {
		expect(() => validatePairOffer(value)).toThrow();
	});
});

describe("validatePairOfferStatus", () => {
	it("accepts a pending status", () => {
		const status: PairOfferStatus = { status: "pending", expiresAt: 5 };
		expect(validatePairOfferStatus(status)).toEqual(status);
	});

	it("accepts an expired status", () => {
		expect(validatePairOfferStatus({ status: "expired" })).toEqual({
			status: "expired",
		});
	});

	it("accepts a claimed status carrying a bootstrap for any agent identity", () => {
		expect(validatePairOfferStatus({ status: "claimed", bootstrap })).toEqual({
			status: "claimed",
			bootstrap,
		});
		expect(
			validatePairOfferStatus({
				status: "claimed",
				bootstrap: { ...bootstrap, agentIdentity: "extension" },
			}).status,
		).toBe("claimed");
	});

	it.each([
		["an unknown status", { status: "done" }],
		["a pending status without expiresAt", { status: "pending" }],
		["a claimed status without a bootstrap", { status: "claimed" }],
		[
			"a claimed bootstrap without a token",
			{ status: "claimed", bootstrap: { ...bootstrap, token: undefined } },
		],
		["a non-record", "pending"],
	])("rejects %s", (_name, value) => {
		expect(() => validatePairOfferStatus(value)).toThrow();
	});
});

describe("validatePairClaimRequest", () => {
	it("accepts a six digit code with a session id", () => {
		expect(
			validatePairClaimRequest({ code: "004219", sessionId: "session-a" }),
		).toEqual({ code: "004219", sessionId: "session-a" });
	});

	it.each([
		["a short code", { code: "4219", sessionId: "s" }],
		["a long code", { code: "1234567", sessionId: "s" }],
		["a non-digit code", { code: "12345a", sessionId: "s" }],
		["a numeric code", { code: 123456, sessionId: "s" }],
		["a missing session id", { code: "123456" }],
		["null", null],
	])("rejects %s", (_name, value) => {
		expect(() => validatePairClaimRequest(value)).toThrow();
	});
});
