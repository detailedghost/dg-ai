import { describe, expect, it } from "bun:test";
import { VERBS, validate } from "../src/pw-ext-verbs/input";

describe("input verbs contract", () => {
	it("exports the five input verbs", () => {
		expect([...VERBS]).toEqual(["check", "uncheck", "type", "keydown", "keyup"]);
	});
});

describe("validate", () => {
	it.each([
		{ verb: "check", target: "e3" },
		{ verb: "uncheck", target: "#agree", tabId: 7 },
		{ verb: "type", text: "hello" },
		{ verb: "type", text: "hello", submit: true, tabId: 0 },
		{ verb: "keydown", key: "Shift" },
		{ verb: "keyup", key: "a", tabId: 12 },
	])("accepts %j", (request) => {
		expect(validate(request)).toEqual(request as never);
	});

	it.each([
		[{ verb: "click", target: "e1" }, "verb"],
		[{ verb: "check" }, "target"],
		[{ verb: "check", target: "" }, "target"],
		[{ verb: "check", target: "x".repeat(513) }, "target"],
		[{ verb: "check", target: "e1", text: "no" }, "unknown field"],
		[{ verb: "check", target: "e1", tabId: -1 }, "tabId"],
		[{ verb: "check", target: "e1", tabId: 1.5 }, "tabId"],
		[{ verb: "type" }, "text"],
		[{ verb: "type", text: "" }, "text"],
		[{ verb: "type", text: "x".repeat(4097) }, "text"],
		[{ verb: "type", text: "a", submit: false }, "submit"],
		[{ verb: "keydown" }, "key"],
		[{ verb: "keydown", key: "Shift+A" }, "key"],
		[{ verb: "keyup", key: "NotAKey" }, "key"],
		[{ verb: "keydown", key: "Enter", submit: true }, "unknown field"],
		["check", "object"],
		[null, "object"],
	])("rejects %j", (request, message) => {
		expect(() => validate(request)).toThrow(message);
	});
});
