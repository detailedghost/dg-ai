import { describe, expect, it } from "bun:test";
import { parseEvery } from "../src/chat-format";

describe("parseEvery flag name", () => {
	it("defaults the flag name to --every in both errors", () => {
		expect(() => parseEvery("30")).toThrow(
			'--every: expected a count and a unit of s, m or h (for example 15m), got "30"',
		);
		expect(() => parseEvery("0s")).toThrow(
			'--every: interval must be greater than zero, got "0s"',
		);
	});

	it("uses the given flag name in both errors", () => {
		expect(() => parseEvery("30", "--stop-timeout")).toThrow(
			'--stop-timeout: expected a count and a unit of s, m or h (for example 15m), got "30"',
		);
		expect(() => parseEvery("0s", "--stop-timeout")).toThrow(
			'--stop-timeout: interval must be greater than zero, got "0s"',
		);
	});

	it("still converts a valid value", () => {
		expect(parseEvery("30s", "--stop-timeout")).toBe(30_000);
	});
});
