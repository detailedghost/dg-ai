import { describe, expect, it } from "bun:test";
import { POINTER_VERBS, parsePointerRequest, PointerUsageError } from "../src/pw/ext-verbs/pointer";

describe("parsePointerRequest", () => {
	it("covers every pointer verb", () => {
		expect([...POINTER_VERBS]).toHaveLength(7);
	});

	it.each([
		["hover", ["e3"], undefined, { verb: "hover", target: "e3" }],
		["dblclick", ["#row"], 9, { verb: "dblclick", tabId: 9, target: "#row" }],
		["drag", ["e1", ".slot"], undefined, { verb: "drag", target: "e1", to: ".slot" }],
		["mousemove", ["10", "20.5"], undefined, { verb: "mousemove", x: 10, y: 20.5 }],
		["mousedown", [], undefined, { verb: "mousedown" }],
		["mouseup", ["right"], undefined, { verb: "mouseup", button: "right" }],
		["mousewheel", ["0", "-120"], undefined, { verb: "mousewheel", dx: 0, dy: -120 }],
	] as const)("builds the %s request", (verb, args, tab, expected) => {
		expect(parsePointerRequest(verb, args, tab)).toEqual(expected as never);
	});

	it.each([
		["hover", []],
		["hover", ["e1", "e2"]],
		["drag", ["e1"]],
		["mousemove", ["10"]],
		["mousemove", ["left", "5"]],
		["mousewheel", ["1", "two"]],
		["mousedown", ["back"]],
		["mousedown", ["left", "right"]],
	] as const)("refuses %s with %j", (verb, args) => {
		expect(() => parsePointerRequest(verb, args)).toThrow(PointerUsageError);
	});

	it("names the verb in the error", () => {
		expect(() => parsePointerRequest("drag", ["e1"])).toThrow("pw --ext drag takes <from-ref|selector> <to-ref|selector>.");
	});

	it("refuses a tab id outside the range", () => {
		expect(() => parsePointerRequest("hover", ["e1"], -2)).toThrow("--tab");
	});
});
