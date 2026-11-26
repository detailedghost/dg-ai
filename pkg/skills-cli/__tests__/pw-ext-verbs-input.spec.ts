import { describe, expect, it } from "bun:test";
import { InputUsageError, parse } from "../src/pw/ext-verbs/input";

describe("parse", () => {
	it.each([
		[{ verb: "check", args: ["e3"] }, { verb: "check", target: "e3" }],
		[{ verb: "uncheck", args: ["#agree"], tab: 7 }, { verb: "uncheck", target: "#agree", tabId: 7 }],
		[{ verb: "type", args: ["hello world"] }, { verb: "type", text: "hello world" }],
		[{ verb: "type", args: ["hi"], submit: true }, { verb: "type", text: "hi", submit: true }],
		[{ verb: "keydown", args: ["shift"] }, { verb: "keydown", key: "Shift" }],
		[{ verb: "keyup", args: ["a"], tab: 0 }, { verb: "keyup", key: "a", tabId: 0 }],
	])("builds the request for %j", (input, request) => {
		expect(parse(input)).toEqual(request as never);
	});

	it.each([
		[{ verb: "check", args: [] }, "pw --ext check takes <target>."],
		[{ verb: "check", args: ["a", "b"] }, "pw --ext check takes <target>."],
		[{ verb: "type", args: [] }, "pw --ext type takes <text>."],
		[{ verb: "keydown", args: [] }, "pw --ext keydown takes <key>."],
		[{ verb: "keydown", args: ["Shift+A"] }, "key"],
		[{ verb: "check", args: ["e1"], submit: true }, "--submit works only with pw --ext type."],
		[{ verb: "click", args: ["e1"] }, "Unknown pw --ext input verb: click."],
	])("refuses %j", (input, message) => {
		expect(() => parse(input)).toThrow(InputUsageError);
		expect(() => parse(input)).toThrow(message);
	});
});
