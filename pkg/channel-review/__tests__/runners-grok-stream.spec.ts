import { describe, expect, test } from "bun:test";
import { foldGrokStream } from "../src/runners/grok-stream";

describe("foldGrokStream", () => {
	test("joins streaming-json text events and keeps the end reason", () => {
		const folded = foldGrokStream(
			[
				'{"type":"text","data":"Hello"}',
				'{"type":"thought","data":"skip me"}',
				'{"type":"text","data":" review"}',
				'{"type":"end","stopReason":"EndTurn","sessionId":"s1","requestId":"r1"}',
			].join("\n"),
		);
		expect(folded.text).toBe("Hello review");
		expect(folded.stopReason).toBe("EndTurn");
		expect(folded.error).toBeUndefined();
	});

	test("collects error events apart from the answer text", () => {
		const folded = foldGrokStream(
			'{"type":"text","data":"the diff says not logged in"}\n{"type":"error","message":"Not logged in"}\n',
		);
		expect(folded.text).toBe("the diff says not logged in");
		expect(folded.error).toBe("Not logged in");
	});

	test("reads the single json object format", () => {
		const folded = foldGrokStream(
			'{"text":"pong","stopReason":"EndTurn","sessionId":"s1","requestId":"r1"}\n',
		);
		expect(folded).toEqual({ text: "pong", stopReason: "EndTurn" });
	});

	test("keeps plain text and ignores non-json lines once an event has started", () => {
		const plain = foldGrokStream("pong\r\n\r\nnext\r\n");
		expect(plain.text).toBe("pong\nnext\n");
		expect(foldGrokStream("   \npong\n").text).toBe("pong\n");
		expect(plain.error).toBeUndefined();
		expect(plain.stopReason).toBeUndefined();
		const mixed = foldGrokStream(
			'{"type":"text","data":"pong"}\nstderr-note\n',
		);
		expect(mixed.text).toBe("pong");
	});

	test("joins every error, keeps a later stop reason, and reads a json error object", () => {
		const streamed = foldGrokStream(
			[
				'{"type":"error","message":"one"}',
				'{"type":"text","data":1}',
				'{"type":"error","message":2}',
				'{"type":"end","stopReason":"ToolUse"}',
				'{"type":"end","stopReason":"EndTurn"}',
				"   ",
			].join("\n"),
		);
		expect(streamed).toEqual({
			text: "",
			error: "one",
			stopReason: "EndTurn",
		});
		expect(
			foldGrokStream(
				'{"type":"error","message":"one"}\n{"type":"error","message":"two"}\n',
			).error,
		).toBe("one\ntwo");
		const withError = foldGrokStream(
			'{"text":"partial","stopReason":"error","message":"boom","error":"api"}\n',
		);
		expect(withError).toEqual({
			text: "partial",
			stopReason: "error",
			error: "api",
		});
		const withMessage = foldGrokStream(
			'{"text":"partial","stopReason":"error","message":"boom"}\n',
		);
		expect(withMessage).toEqual({
			text: "partial",
			stopReason: "error",
			error: "boom",
		});
	});

	test("ignores null, arrays, and numbers instead of throwing", () => {
		const folded = foldGrokStream('null\n[]\n1\n"hi"\n');
		expect(folded).toEqual({ text: "" });
		expect("stopReason" in folded).toBe(false);
	});

	test("parses an indented event and does not treat other types as errors or endings", () => {
		const folded = foldGrokStream(
			[
				'  {"type":"text","data":"pong"}',
				'{"type":"tool","message":"nope","stopReason":"nope"}',
				'{"type":"end","stopReason":1}',
				"after",
			].join("\n"),
		);
		expect(folded).toEqual({ text: "pong" });
		expect("error" in folded).toBe(false);
		expect("stopReason" in folded).toBe(false);
	});

	test("marks a json object as an event from either text or stopReason alone", () => {
		const textOnly = foldGrokStream('{"text":"pong"}\nleftover\n');
		expect(textOnly).toEqual({ text: "pong" });
		const reasonOnly = foldGrokStream('{"stopReason":"EndTurn"}\nstill-plain\n');
		expect(reasonOnly).toEqual({ text: "", stopReason: "EndTurn" });
		const neither = foldGrokStream('{"foo":1}\nkept\n');
		expect(neither.text).toBe("kept\n");
	});

	test("does not coerce non-string json fields or take message unless the stop reason is error", () => {
		expect(foldGrokStream('{"text":1,"stopReason":2}\n')).toEqual({ text: "" });
		expect(foldGrokStream('{"text":"a","message":"boom"}\n')).toEqual({ text: "a" });
		expect(foldGrokStream('{"stopReason":"error","message":1}\n')).toEqual({
			text: "",
			stopReason: "error",
		});
	});
});
