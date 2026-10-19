import { describe, expect, test } from "bun:test";

import { copilot } from "../src/proxy/backends/copilot";
import { makeInput } from "./proxy-fixtures";

describe("copilot.buildArgs", () => {
	test("builds the minimal non-interactive JSON invocation for a bare prompt", () => {
		const args = copilot.buildArgs(makeInput());
		expect(args).toEqual(["-p", "hello world", "--allow-all-tools", "--output-format", "json"]);
	});

	test("appends --resume with the session id when resuming", () => {
		const args = copilot.buildArgs(makeInput({ resume: "sess-123" }));
		expect(args).toContain("--resume");
		expect(args[args.indexOf("--resume") + 1]).toBe("sess-123");
	});

	test("appends --model with the requested model", () => {
		const args = copilot.buildArgs(makeInput({ model: "gpt-5" }));
		expect(args).toContain("--model");
		expect(args[args.indexOf("--model") + 1]).toBe("gpt-5");
	});

	test("appends --effort with the requested effort", () => {
		const args = copilot.buildArgs(makeInput({ effort: "high" }));
		expect(args).toContain("--effort");
		expect(args[args.indexOf("--effort") + 1]).toBe("high");
	});

	test("combines resume, model, and effort flags in one call", () => {
		const args = copilot.buildArgs(makeInput({ resume: "sess-1", model: "gpt-5", effort: "low" }));
		expect(args).toEqual([
			"-p",
			"hello world",
			"--allow-all-tools",
			"--output-format",
			"json",
			"--resume",
			"sess-1",
			"--model",
			"gpt-5",
			"--effort",
			"low",
		]);
	});

	test("omits optional flags entirely when absent", () => {
		const args = copilot.buildArgs(makeInput());
		expect(args).not.toContain("--resume");
		expect(args).not.toContain("--model");
		expect(args).not.toContain("--effort");
	});
});

describe("copilot.parseEvents", () => {
	test("extracts the assistant message and session id from a JSONL stream", () => {
		const stdout = [
			JSON.stringify({ type: "assistant.message", data: { content: "hi there" } }),
			JSON.stringify({ type: "result", sessionId: "sess-abc" }),
		].join("\n");

		expect(copilot.parseEvents(stdout)).toEqual({
			sessionId: "sess-abc",
			message: "hi there",
		});
	});

	test("keeps the latest assistant message when several are streamed", () => {
		const stdout = [
			JSON.stringify({ type: "assistant.message", data: { content: "first" } }),
			JSON.stringify({ type: "assistant.message", data: { content: "second" } }),
		].join("\n");

		expect(copilot.parseEvents(stdout).message).toBe("second");
	});

	test("returns null sessionId and empty message for empty stdout", () => {
		expect(copilot.parseEvents("")).toEqual({ sessionId: null, message: "" });
	});

	test("skips blank lines between JSON events", () => {
		const stdout = [
			"",
			JSON.stringify({ type: "assistant.message", data: { content: "hi" } }),
			"   ",
			JSON.stringify({ type: "result", sessionId: "s1" }),
			"",
		].join("\n");

		expect(copilot.parseEvents(stdout)).toEqual({ sessionId: "s1", message: "hi" });
	});

	test("skips malformed JSON lines without throwing", () => {
		const stdout = ["not json at all {", JSON.stringify({ type: "assistant.message", data: { content: "ok" } })].join(
			"\n",
		);

		expect(() => copilot.parseEvents(stdout)).not.toThrow();
		expect(copilot.parseEvents(stdout).message).toBe("ok");
	});

	test("falls back to null sessionId when result event omits sessionId", () => {
		const stdout = JSON.stringify({ type: "result" });
		expect(copilot.parseEvents(stdout).sessionId).toBeNull();
	});

	test("keeps prior message when an assistant.message event has no content", () => {
		const stdout = [
			JSON.stringify({ type: "assistant.message", data: { content: "keep me" } }),
			JSON.stringify({ type: "assistant.message", data: {} }),
		].join("\n");

		expect(copilot.parseEvents(stdout).message).toBe("keep me");
	});

	test("ignores unrecognized event types", () => {
		const stdout = [JSON.stringify({ type: "tool.call", data: { content: "should be ignored" } })].join("\n");

		expect(copilot.parseEvents(stdout)).toEqual({ sessionId: null, message: "" });
	});
});

