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
		const plain = foldGrokStream("pong\n");
		expect(plain.text).toBe("pong\n");
		expect(plain.error).toBeUndefined();
		const mixed = foldGrokStream(
			'{"type":"text","data":"pong"}\nstderr-note\n',
		);
		expect(mixed.text).toBe("pong");
	});
});
