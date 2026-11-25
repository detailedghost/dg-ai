import { describe, expect, it } from "bun:test";
import { PW_EXT_MAX_TAB_ID } from "@dg/common";
import { NavigationUsageError, VERBS, buildRequest, isNavigationVerb } from "../src/pw/ext-verbs/navigation";

describe("navigation CLI client", () => {
	it.each(VERBS)("builds a %s request for the selected tab", (verb) => {
		expect(buildRequest(verb, [])).toEqual({ verb });
	});

	it("targets one tab with --tab", () => {
		expect(buildRequest("go-back", [], "12")).toEqual({ verb: "go-back", tabId: 12 });
	});

	it("recognizes only its own verbs", () => {
		expect(isNavigationVerb("reload")).toBe(true);
		expect(isNavigationVerb("click")).toBe(false);
		expect(isNavigationVerb(undefined)).toBe(false);
	});

	it.each([
		["a verb of another module", "click", [], undefined],
		["no verb", undefined, [], undefined],
		["an extra argument", "reload", ["https://example.test"], undefined],
		["a non-numeric tab", "reload", [], "abc"],
		["a negative tab", "reload", [], "-1"],
		["a tab past the maximum", "reload", [], String(PW_EXT_MAX_TAB_ID + 1)],
	])("rejects %s", (_name, verb, args, tab) => {
		expect(() => buildRequest(verb, args, tab)).toThrow(NavigationUsageError);
	});
});
