import { describe, expect, it } from "bun:test";
import { STORAGE_USAGE, storageRequestOf } from "../src/pw/ext-verbs/storage";

describe("pw --ext storage verb client", () => {
	it("builds a set request from key and value", () => {
		expect(storageRequestOf("localstorage-set", ["theme", "dark"])).toEqual({
			verb: "localstorage-set",
			key: "theme",
			value: "dark",
		});
	});

	it("keeps an empty value and a value that looks like a flag", () => {
		expect(storageRequestOf("sessionstorage-set", ["k", ""]).value).toBe("");
		expect(storageRequestOf("sessionstorage-set", ["k", "--tab"]).value).toBe("--tab");
	});

	it("builds delete and clear requests with an optional tab", () => {
		expect(storageRequestOf("localstorage-delete", ["k"], "12")).toEqual({
			verb: "localstorage-delete",
			key: "k",
			tabId: 12,
		});
		expect(storageRequestOf("sessionstorage-clear", [])).toEqual({ verb: "sessionstorage-clear" });
	});

	it.each([
		["set with one argument", "localstorage-set", ["k"], undefined, /takes <key> <value>/],
		["delete with no key", "localstorage-delete", [], undefined, /takes <key>/],
		["clear with an argument", "sessionstorage-clear", ["k"], undefined, /takes no arguments/],
		["a bad tab", "localstorage-clear", [], "abc", /tab id/],
		["an oversized key", "localstorage-delete", ["k".repeat(600)], undefined, /too long/],
	])("rejects %s with a usage message", (_name, verb, args, tab, message) => {
		expect(() => storageRequestOf(verb as never, args, tab)).toThrow(message);
	});

	it("documents all six verbs", () => {
		for (const verb of ["localstorage-set", "localstorage-delete", "localstorage-clear", "sessionstorage-set", "sessionstorage-delete", "sessionstorage-clear"])
			expect(STORAGE_USAGE).toContain(verb);
	});
});
