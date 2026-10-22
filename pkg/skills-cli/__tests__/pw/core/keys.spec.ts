import { describe, expect, test } from "bun:test";
import { normalizeKey } from "../../../src/pw/core/keys";

describe("normalizeKey", () => {
	test.each([
		["arrowleft", "ArrowLeft"],
		["ENTER", "Enter"],
		["control+a", "Control+a"],
		["shift+arrowdown", "Shift+ArrowDown"],
		["f5", "F5"],
		["a", "a"],
		["+", "+"],
		["Control++", "Control++"],
		["Unknown", "Unknown"],
	])("%s -> %s", (input, expected) => {
		expect(normalizeKey(input)).toBe(expected);
	});
});
