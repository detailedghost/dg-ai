import { describe, expect, it } from "bun:test";
import {
	PW_EXT_MAX_KEY_CHARS,
	PW_EXT_MAX_VALUE_BYTES,
} from "../src/pw-ext-format";
import {
	storageActionOf,
	storageAreaOf,
	validate,
	VERBS,
} from "../src/pw-ext-verbs/storage";

describe("pw-ext-verbs/storage", () => {
	it("lists the six storage write verbs", () => {
		expect([...VERBS]).toEqual([
			"localstorage-set",
			"localstorage-delete",
			"localstorage-clear",
			"sessionstorage-set",
			"sessionstorage-delete",
			"sessionstorage-clear",
		]);
	});

	it("splits a verb into its storage area and action", () => {
		expect(storageAreaOf("sessionstorage-delete")).toBe("session");
		expect(storageAreaOf("localstorage-set")).toBe("local");
		expect(storageActionOf("localstorage-clear")).toBe("clear");
		expect(storageActionOf("sessionstorage-set")).toBe("set");
	});

	it("accepts a set with a key, a value and a tab", () => {
		expect(
			validate({ verb: "localstorage-set", key: "theme", value: "dark", tabId: 7 }),
		).toEqual({ verb: "localstorage-set", key: "theme", value: "dark", tabId: 7 });
	});

	it("accepts an empty value on set", () => {
		expect(validate({ verb: "sessionstorage-set", key: "k", value: "" }).value).toBe("");
	});

	it("accepts a delete with a key and a clear with nothing", () => {
		expect(validate({ verb: "localstorage-delete", key: "k" })).toEqual({
			verb: "localstorage-delete",
			key: "k",
		});
		expect(validate({ verb: "sessionstorage-clear" })).toEqual({
			verb: "sessionstorage-clear",
		});
	});

	it.each([
		["a non-object", "nope", /must be an object/],
		["an unknown verb", { verb: "cookie-set" }, /not a supported verb/],
		["a set without a value", { verb: "localstorage-set", key: "k" }, /value/],
		["a set without a key", { verb: "localstorage-set", value: "v" }, /key/],
		["a delete without a key", { verb: "localstorage-delete" }, /key/],
		["a delete with a value", { verb: "localstorage-delete", key: "k", value: "v" }, /value/],
		["a clear with a key", { verb: "localstorage-clear", key: "k" }, /key/],
		["an empty key", { verb: "localstorage-delete", key: " " }, /key/],
		["an unknown field", { verb: "localstorage-clear", url: "https://a.test" }, /url/],
		["a negative tab id", { verb: "localstorage-clear", tabId: -1 }, /tabId/],
		["a fractional tab id", { verb: "localstorage-clear", tabId: 1.5 }, /tabId/],
		[
			"a key over the limit",
			{ verb: "localstorage-delete", key: "k".repeat(PW_EXT_MAX_KEY_CHARS + 1) },
			/too long/,
		],
		[
			"a value over the byte limit",
			{ verb: "localstorage-set", key: "k", value: "é".repeat(PW_EXT_MAX_VALUE_BYTES) },
			/too long/,
		],
	])("rejects %s", (_name, input, message) => {
		expect(() => validate(input)).toThrow(message);
	});
});
