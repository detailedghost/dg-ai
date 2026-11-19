import { describe, expect, it } from "bun:test";
import { formatDurationMs } from "../src/chat-format";

describe("formatDurationMs", () => {
	it.each([
		[800, "800ms"],
		[1_500, "1500ms"],
		[1_000, "1s"],
		[90_000, "90s"],
		[300_000, "5m"],
		[3_600_000, "1h"],
	])("writes %p as %p", (ms, text) => {
		expect(formatDurationMs(ms)).toBe(text);
	});
});
