import { describe, expect, test } from "bun:test";
import { normalizeKey, parseKeyChord } from "../src/keyboard-keys";

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

describe("parseKeyChord", () => {
	test.each([
		["Enter", { key: "Enter", modifiers: [] }],
		["a", { key: "a", modifiers: [] }],
		["+", { key: "+", modifiers: [] }],
		["Shift+Tab", { key: "Tab", modifiers: ["Shift"] }],
		["Control++", { key: "+", modifiers: ["Control"] }],
		["ControlOrMeta+Shift+ArrowDown", { key: "ArrowDown", modifiers: ["ControlOrMeta", "Shift"] }],
		["Shift", { key: "Shift", modifiers: [] }],
	])("%s splits into its key and modifiers", (chord, expected) => {
		expect(parseKeyChord(chord)).toEqual(expected as never);
	});

	test.each(["", "ab", "enter", "Control+", "Shift+Shift", "Hyper+a", "a+Shift", "x".repeat(65)])(
		"%p is not a chord",
		(chord) => {
			expect(parseKeyChord(chord)).toBeUndefined();
		},
	);
});
