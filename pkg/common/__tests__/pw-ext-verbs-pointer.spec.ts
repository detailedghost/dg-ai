import { describe, expect, it } from "bun:test";
import { VERBS, validate } from "../src/pw-ext-verbs/pointer";

describe("VERBS", () => {
	it("lists the seven pointer verbs", () => {
		expect([...VERBS]).toEqual(["hover", "dblclick", "drag", "mousedown", "mouseup", "mousemove", "mousewheel"]);
	});
});

describe("validate", () => {
	it.each([
		[{ verb: "hover", target: "e3" }],
		[{ verb: "dblclick", tabId: 7, target: "#row" }],
		[{ verb: "drag", target: "e1", to: ".slot" }],
		[{ verb: "mousemove", x: 10, y: 20.5 }],
		[{ verb: "mousedown" }],
		[{ verb: "mouseup", button: "right" }],
		[{ verb: "mousewheel", dx: 0, dy: -120 }],
	])("accepts %j", (request) => expect(validate(request)).toEqual(request as never));

	it.each([
		[{ verb: "hover" }, "request.target"],
		[{ verb: "hover", target: "" }, "request.target"],
		[{ verb: "hover", target: "a".repeat(513) }, "request.target"],
		[{ verb: "drag", target: "e1" }, "request.to"],
		[{ verb: "mousemove", x: -1, y: 0 }, "request.x"],
		[{ verb: "mousemove", x: 1, y: Number.NaN }, "request.y"],
		[{ verb: "mousedown", button: "back" }, "request.button"],
		[{ verb: "mousewheel", dx: 1 }, "request.dy"],
		[{ verb: "mousewheel", dx: 1, dy: 1_000_000 }, "request.dy"],
		[{ verb: "hover", target: "e1", tabId: -1 }, "request.tabId"],
		[{ verb: "hover", target: "e1", tabId: 1.5 }, "request.tabId"],
		[{ verb: "hover", target: "e1", to: "e2" }, "request.to"],
		[{ verb: "click", target: "e1" }, "request.verb"],
	])("rejects %j", (request, path) => expect(() => validate(request)).toThrow(path));

	it("rejects a non-object", () => {
		expect(() => validate("hover")).toThrow("request must be an object");
	});
});
