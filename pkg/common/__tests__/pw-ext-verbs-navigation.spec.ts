import { describe, expect, it } from "bun:test";
import { PW_EXT_MAX_TAB_ID } from "../src/pw-ext-format";
import { VERBS, validate } from "../src/pw-ext-verbs/navigation";

describe("navigation verbs contract", () => {
	it("lists go-back, go-forward and reload", () => {
		expect([...VERBS]).toEqual(["go-back", "go-forward", "reload"]);
	});

	it.each(VERBS)("accepts %s with and without a tab id", (verb) => {
		expect(validate({ verb })).toEqual({ verb });
		expect(validate({ verb, tabId: 7 })).toEqual({ verb, tabId: 7 });
	});

	it("accepts the largest tab id", () => {
		expect(validate({ verb: "reload", tabId: PW_EXT_MAX_TAB_ID }).tabId).toBe(PW_EXT_MAX_TAB_ID);
	});

	it.each([
		["a non-object", "reload"],
		["an array", []],
		["a missing verb", {}],
		["another verb", { verb: "click" }],
		["an inherited verb name", { verb: "toString" }],
		["an unknown field", { verb: "reload", url: "https://example.test" }],
		["a negative tab id", { verb: "reload", tabId: -1 }],
		["a fractional tab id", { verb: "reload", tabId: 1.5 }],
		["a string tab id", { verb: "reload", tabId: "7" }],
		["a tab id past the maximum", { verb: "reload", tabId: PW_EXT_MAX_TAB_ID + 1 }],
	])("rejects %s", (_name, value) => {
		expect(() => validate(value)).toThrow(TypeError);
	});
});
