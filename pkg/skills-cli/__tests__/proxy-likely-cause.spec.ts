import { describe, expect, test } from "bun:test";

import { classifyFailure } from "../src/proxy/likely-cause";

describe("classifyFailure", () => {
	test("returns 'model' when a rejection word co-occurs with 'model'", () => {
		expect(classifyFailure("Error: unknown model 'gpt-9'")).toBe("model");
	});

	test("returns 'effort' when a rejection word co-occurs with an effort word", () => {
		expect(classifyFailure("unsupported reasoning effort level")).toBe("effort");
	});

	test("returns 'other' when no rejection word is present", () => {
		expect(classifyFailure("connection timed out")).toBe("other");
	});

	test("returns 'other' when a rejection word appears without model or effort context", () => {
		expect(classifyFailure("file not found: config.json")).toBe("other");
	});

	// model check is ordered before effort check, so text hitting both keys as "model"
	test("prioritizes 'model' over 'effort' when both keywords are present", () => {
		expect(classifyFailure("invalid model: reasoning effort not supported")).toBe("model");
	});

	test("matches case-insensitively", () => {
		expect(classifyFailure("UNKNOWN MODEL requested")).toBe("model");
	});

	test("matches each rejection word individually", () => {
		for (const word of [
			"unknown",
			"invalid",
			"unsupported",
			"not found",
			"not available",
			"unrecognized",
			"not support",
		]) {
			expect(classifyFailure(`${word} model type`)).toBe("model");
		}
	});

	test("matches each effort word individually", () => {
		for (const word of ["effort", "thinking", "variant", "reasoning"]) {
			expect(classifyFailure(`unsupported ${word} setting`)).toBe("effort");
		}
	});

	test("returns 'other' for empty input", () => {
		expect(classifyFailure("")).toBe("other");
	});

	test("does not classify 'model' alone as a rejection without a rejection word", () => {
		expect(classifyFailure("model loaded successfully")).toBe("other");
	});
});
