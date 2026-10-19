import { describe, expect, test } from "bun:test";

import { pi } from "../src/proxy/backends/pi";
import { makeInput } from "./proxy-fixtures";

function sessionEvent(id: string): string {
	return JSON.stringify({ type: "session", id });
}

function messageEndEvent(text: string, role = "assistant"): string {
	return JSON.stringify({
		type: "message_end",
		message: { role, content: [{ type: "text", text }] },
	});
}

describe("pi.buildArgs", () => {
	test("builds the minimal args for a bare prompt", () => {
		const args = pi.buildArgs(makeInput());
		expect(args).toEqual(["--print", "hello world", "--mode", "json"]);
	});

	test("appends --resume when resume is provided", () => {
		const args = pi.buildArgs(makeInput({ resume: "sess-123" }));
		expect(args).toEqual(["--print", "hello world", "--mode", "json", "--resume", "sess-123"]);
	});

	test("appends --model when model is provided", () => {
		const args = pi.buildArgs(makeInput({ model: "gpt-5" }));
		expect(args).toEqual(["--print", "hello world", "--mode", "json", "--model", "gpt-5"]);
	});

	test("appends --thinking when effort is provided", () => {
		const args = pi.buildArgs(makeInput({ effort: "high" }));
		expect(args).toEqual(["--print", "hello world", "--mode", "json", "--thinking", "high"]);
	});

	test("appends resume, model, and effort together in declaration order", () => {
		const args = pi.buildArgs(makeInput({ resume: "sess-1", model: "gpt-5", effort: "low" }));
		expect(args).toEqual([
			"--print",
			"hello world",
			"--mode",
			"json",
			"--resume",
			"sess-1",
			"--model",
			"gpt-5",
			"--thinking",
			"low",
		]);
	});

	test("omits optional flags entirely when their values are undefined", () => {
		const args = pi.buildArgs(makeInput({ resume: undefined, model: undefined, effort: undefined }));
		expect(args).not.toContain("--resume");
		expect(args).not.toContain("--model");
		expect(args).not.toContain("--thinking");
	});
});

describe("pi.parseEvents", () => {
	test("returns null sessionId and empty message for empty stdout", () => {
		const result = pi.parseEvents("");
		expect(result).toEqual({ sessionId: null, message: "" });
	});

	test("skips blank lines between JSON events", () => {
		const stdout = [sessionEvent("abc"), "", "   ", messageEndEvent("hi")].join("\n");
		const result = pi.parseEvents(stdout);
		expect(result.sessionId).toBe("abc");
		expect(result.message).toBe("hi");
	});

	test("skips malformed JSON lines without throwing", () => {
		const stdout = ["not json {{{", sessionEvent("abc"), messageEndEvent("hi")].join("\n");
		expect(() => pi.parseEvents(stdout)).not.toThrow();
		expect(pi.parseEvents(stdout)).toEqual({ sessionId: "abc", message: "hi" });
	});

	test("extracts sessionId from the first session event", () => {
		const result = pi.parseEvents(sessionEvent("session-1"));
		expect(result.sessionId).toBe("session-1");
	});

	test("keeps the first sessionId when multiple session events appear", () => {
		const stdout = [sessionEvent("first"), sessionEvent("second")].join("\n");
		const result = pi.parseEvents(stdout);
		expect(result.sessionId).toBe("first");
	});

	test("session event with a null id leaves sessionId null", () => {
		const stdout = JSON.stringify({ type: "session", id: null });
		const result = pi.parseEvents(stdout);
		expect(result.sessionId).toBeNull();
	});

	test("concatenates multiple text blocks from a message_end event", () => {
		const stdout = JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "hello " },
					{ type: "text", text: "world" },
				],
			},
		});
		const result = pi.parseEvents(stdout);
		expect(result.message).toBe("hello world");
	});

	test("ignores non-text content blocks when building the message", () => {
		const stdout = JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "tool_use", text: "should not appear" },
					{ type: "text", text: "kept" },
				],
			},
		});
		const result = pi.parseEvents(stdout);
		expect(result.message).toBe("kept");
	});

	test("ignores message_end events from a non-assistant role", () => {
		const stdout = messageEndEvent("user text", "user");
		const result = pi.parseEvents(stdout);
		expect(result.message).toBe("");
	});

	test("uses the last assistant message_end when multiple appear", () => {
		const stdout = [messageEndEvent("first"), messageEndEvent("second")].join("\n");
		const result = pi.parseEvents(stdout);
		expect(result.message).toBe("second");
	});

	test("treats a missing content array as producing an empty message", () => {
		const stdout = JSON.stringify({
			type: "message_end",
			message: { role: "assistant" },
		});
		const result = pi.parseEvents(stdout);
		expect(result.message).toBe("");
	});

	test("ignores unrecognized event types", () => {
		const stdout = JSON.stringify({ type: "ping" });
		const result = pi.parseEvents(stdout);
		expect(result).toEqual({ sessionId: null, message: "" });
	});

	test("combines a session event and a message_end event from a realistic stream", () => {
		const stdout = [sessionEvent("real-session"), messageEndEvent("done")].join("\n");
		const result = pi.parseEvents(stdout);
		expect(result).toEqual({ sessionId: "real-session", message: "done" });
	});
});

