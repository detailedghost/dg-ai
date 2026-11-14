import { describe, expect, test } from "bun:test";
import { stripTerminalEscapes } from "../src";

describe("stripTerminalEscapes", () => {
	test("removes color, cursor, and OSC sequences and control bytes", () => {
		const raw = "\x1b[31mred\x1b[0m \x1b[2K\x1b]0;title\x07ok\x1b]8;;http://x\x1b\\link\x00\x08\x7f";
		expect(stripTerminalEscapes(raw)).toBe("red oklink");
	});

	test("keeps tabs and newlines", () => {
		expect(stripTerminalEscapes("a\tb\nc\r\nd")).toBe("a\tb\nc\r\nd");
	});
});
