import { describe, expect, it } from "bun:test";
import {
	type PairResponse,
	validatePairRequest,
	validatePairResponse,
} from "../src/index";

describe("validatePairRequest", () => {
	it("accepts a six digit pairing code", () => {
		expect(validatePairRequest({ code: "004219" })).toEqual({
			code: "004219",
		});
	});

	it.each(["4219", "1234567", "12345a", 123456, null])(
		"rejects an invalid pairing code: %p",
		(code) => {
			expect(() => validatePairRequest({ code })).toThrow();
		},
	);
});

describe("validatePairResponse", () => {
	it("accepts a complete extension session bootstrap", () => {
		const response = {
			port: 47823,
			sessionId: "session-a",
			token: "token-a",
			agentIdentity: "extension",
		} satisfies PairResponse;

		expect(validatePairResponse(response)).toEqual(response);
	});

	it("rejects a response without a session token", () => {
		expect(() =>
			validatePairResponse({
				port: 47823,
				sessionId: "session-a",
				agentIdentity: "extension",
			}),
		).toThrow();
	});

	it("rejects a bootstrap for an identity other than the extension", () => {
		expect(() =>
			validatePairResponse({
				port: 47823,
				sessionId: "session-a",
				token: "token-a",
				agentIdentity: "agent",
			}),
		).toThrow();
	});
});
