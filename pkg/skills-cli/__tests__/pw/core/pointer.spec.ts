import { describe, expect, test } from "bun:test";
import {
	parseButton,
	parseModifiers,
	pointerOptions,
} from "../../../src/pw/core/pointer";

describe("option parsing", () => {
	test("defaults the button to left and rejects unknown buttons", () => {
		expect(parseButton(undefined)).toBe("left");
		expect(parseButton("middle")).toBe("middle");
		expect(() => parseButton("back")).toThrow("Unsupported button 'back'");
	});

	test("splits comma separated modifiers and rejects unknown ones", () => {
		expect(parseModifiers(undefined)).toEqual([]);
		expect(parseModifiers("Shift, Control")).toEqual(["Shift", "Control"]);
		expect(() => parseModifiers("Hyper")).toThrow(
			"Unsupported modifier 'Hyper'",
		);
	});
});

describe("pointerOptions", () => {
	test("is empty for a plain left click and lists only what differs", () => {
		expect(pointerOptions("left", [])).toBe("");
		expect(pointerOptions("right", ["Shift"])).toBe(
			'{"button":"right","modifiers":["Shift"]}',
		);
	});
});
