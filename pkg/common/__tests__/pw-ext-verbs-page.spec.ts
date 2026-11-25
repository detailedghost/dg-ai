import { describe, expect, it } from "bun:test";
import { PW_EXT_MAX_TAB_ID } from "../src/pw-ext-format";
import { EVAL_MAX_BYTES, RESIZE_MAX, RESIZE_MIN, validate, VERBS } from "../src/pw-ext-verbs/page";

describe("pw-ext-verbs/page", () => {
	it("lists eval, tab-select and resize", () => {
		expect([...VERBS]).toEqual(["eval", "tab-select", "resize"]);
	});

	it("accepts each verb with its fields", () => {
		expect(validate({ verb: "eval", expression: "1 + 1" })).toEqual({ verb: "eval", expression: "1 + 1" });
		expect(validate({ verb: "eval", expression: "document.title", tabId: 4 }).tabId).toBe(4);
		expect(validate({ verb: "tab-select", tabId: 0 })).toEqual({ verb: "tab-select", tabId: 0 });
		expect(validate({ verb: "resize", width: 800, height: 600 })).toEqual({ verb: "resize", width: 800, height: 600 });
		expect(validate({ verb: "resize", width: RESIZE_MAX, height: RESIZE_MIN, tabId: 3 }).tabId).toBe(3);
		expect(validate({ verb: "tab-select", tabId: PW_EXT_MAX_TAB_ID }).tabId).toBe(PW_EXT_MAX_TAB_ID);
	});

	it.each([
		["a non-record", "eval"],
		["an unknown verb", { verb: "click" }],
		["eval without an expression", { verb: "eval" }],
		["eval with an empty expression", { verb: "eval", expression: "" }],
		["eval with a non-string expression", { verb: "eval", expression: 1 }],
		["an oversized expression", { verb: "eval", expression: "x".repeat(EVAL_MAX_BYTES + 1) }],
		["tab-select without a tab id", { verb: "tab-select" }],
		["tab-select with a negative tab id", { verb: "tab-select", tabId: -1 }],
		["a tab id past the maximum", { verb: "eval", expression: "1", tabId: PW_EXT_MAX_TAB_ID + 1 }],
		["a string tab id", { verb: "eval", expression: "1", tabId: "7" }],
		["resize without a height", { verb: "resize", width: 800 }],
		["a fractional width", { verb: "resize", width: 800.5, height: 600 }],
		["a width below the minimum", { verb: "resize", width: RESIZE_MIN - 1, height: 600 }],
		["a height above the maximum", { verb: "resize", width: 800, height: RESIZE_MAX + 1 }],
		["an expression on resize", { verb: "resize", width: 800, height: 600, expression: "1" }],
		["a width on eval", { verb: "eval", expression: "1", width: 800 }],
		["a tab-select with a size", { verb: "tab-select", tabId: 1, width: 800 }],
		["an unknown field", { verb: "eval", expression: "1", extra: true }],
	])("rejects %s", (_name, value) => {
		expect(() => validate(value)).toThrow();
	});
});
