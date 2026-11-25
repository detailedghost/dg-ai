import { describe, expect, it } from "bun:test";
import { PAGE_USAGE, pageRequestOf } from "../src/pw/ext-verbs/page";

describe("pw --ext page verb client", () => {
	it("builds an eval request and keeps an expression that looks like a flag", () => {
		expect(pageRequestOf("eval", ["document.title"])).toEqual({ verb: "eval", expression: "document.title" });
		expect(pageRequestOf("eval", ["--tab"], "5")).toEqual({ verb: "eval", expression: "--tab", tabId: 5 });
	});

	it("builds a tab-select request from the tab id", () => {
		expect(pageRequestOf("tab-select", ["12"])).toEqual({ verb: "tab-select", tabId: 12 });
	});

	it("builds a resize request with an optional tab", () => {
		expect(pageRequestOf("resize", ["800", "600"])).toEqual({ verb: "resize", width: 800, height: 600 });
		expect(pageRequestOf("resize", ["800", "600"], "3")).toEqual({ verb: "resize", width: 800, height: 600, tabId: 3 });
	});

	it.each([
		["eval with no expression", "eval", [], undefined, /takes <expression>/],
		["eval with two arguments", "eval", ["a", "b"], undefined, /takes <expression>/],
		["eval with a bad tab", "eval", ["1"], "abc", /tab id/],
		["tab-select with no id", "tab-select", [], undefined, /takes <tabId>/],
		["tab-select with a non-numeric id", "tab-select", ["abc"], undefined, /tab id/],
		["tab-select with --tab", "tab-select", ["1"], "2", /--tab/],
		["resize with one number", "resize", ["800"], undefined, /takes <width> <height>/],
		["resize with a non-numeric size", "resize", ["wide", "600"], undefined, /whole number/],
		["resize with a tiny size", "resize", ["1", "600"], undefined, /between/],
		["an unknown verb", "click", [], undefined, /Unknown pw --ext verb/],
	])("rejects %s with a usage message", (_name, verb, args, tab, message) => {
		expect(() => pageRequestOf(verb as never, args, tab)).toThrow(message);
	});

	it("documents all three verbs", () => {
		for (const verb of ["eval", "tab-select", "resize"]) expect(PAGE_USAGE).toContain(verb);
	});
});
