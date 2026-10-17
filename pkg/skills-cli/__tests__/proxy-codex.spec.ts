import { describe, expect, test } from "bun:test";

import { codex } from "../src/proxy/backends/codex";
import { jsonl, makeInput } from "./proxy-fixtures";

describe("codex.buildArgs", () => {
	test("builds a fresh-turn invocation with sandbox flags", () => {
		const args = codex.buildArgs(makeInput({ prompt: "hello" }));
		expect(args).toEqual(["exec", "hello", "--json", "-s", "workspace-write"]);
	});

	test("builds a resume invocation targeting the given session id", () => {
		const args = codex.buildArgs(makeInput({ prompt: "hello", resume: "sess-123" }));
		expect(args).toEqual(["exec", "resume", "sess-123", "hello", "--json"]);
	});

	test("appends -m with the model when provided", () => {
		const args = codex.buildArgs(makeInput({ model: "gpt-5" }));
		expect(args.slice(-2)).toEqual(["-m", "gpt-5"]);
	});

	test("appends the reasoning-effort config override when provided", () => {
		const args = codex.buildArgs(makeInput({ effort: "high" }));
		expect(args.slice(-2)).toEqual(["-c", "model_reasoning_effort=high"]);
	});

	test("omits -m and -c entirely when model and effort are absent", () => {
		const args = codex.buildArgs(makeInput());
		expect(args).not.toContain("-m");
		expect(args).not.toContain("-c");
	});

	test("stacks model and effort flags after the resume args, in that order", () => {
		const args = codex.buildArgs(makeInput({ resume: "sess-1", model: "gpt-5", effort: "low" }));
		expect(args).toEqual([
			"exec",
			"resume",
			"sess-1",
			"hello world",
			"--json",
			"-m",
			"gpt-5",
			"-c",
			"model_reasoning_effort=low",
		]);
	});
});

describe("codex.parseEvents", () => {
	test("extracts sessionId from thread.started and message from agent_message", () => {
		const stdout = jsonl(
			{ type: "thread.started", thread_id: "abc" },
			{ type: "item.completed", item: { type: "agent_message", text: "hi there" } },
		);
		expect(codex.parseEvents(stdout)).toEqual({ sessionId: "abc", message: "hi there" });
	});

	test("keeps the first thread.started id when the stream emits more than one", () => {
		const stdout = jsonl(
			{ type: "thread.started", thread_id: "first" },
			{ type: "thread.started", thread_id: "second" },
		);
		expect(codex.parseEvents(stdout).sessionId).toBe("first");
	});

	test("keeps the last agent_message text when several are streamed", () => {
		const stdout = jsonl(
			{ type: "item.completed", item: { type: "agent_message", text: "draft" } },
			{ type: "item.completed", item: { type: "agent_message", text: "final" } },
		);
		expect(codex.parseEvents(stdout).message).toBe("final");
	});

	test("ignores item.completed events for non-agent_message item types", () => {
		const stdout = jsonl({ type: "item.completed", item: { type: "tool_call", text: "should not surface" } });
		expect(codex.parseEvents(stdout).message).toBe("");
	});

	test("skips blank lines and unparseable JSON without throwing", () => {
		const stdout = [
			"",
			"   ",
			"not json{{{",
			JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } }),
		].join("\n");
		expect(codex.parseEvents(stdout)).toEqual({ sessionId: null, message: "ok" });
	});

	test("returns null sessionId and empty message for empty stdout", () => {
		expect(codex.parseEvents("")).toEqual({ sessionId: null, message: "" });
	});

	test("falls back to the turn.failed error message when no agent_message arrived", () => {
		const stdout = jsonl({
			type: "turn.failed",
			error: { message: JSON.stringify({ error: { message: "sandbox denied" } }) },
		});
		expect(codex.parseEvents(stdout).message).toBe("sandbox denied");
	});

	test("falls back to the raw turn.failed message when it is not JSON-wrapped", () => {
		const stdout = jsonl({ type: "turn.failed", error: { message: "plain failure text" } });
		expect(codex.parseEvents(stdout).message).toBe("plain failure text");
	});

	test("falls back to an unwrapped top-level error event", () => {
		const stdout = jsonl({
			type: "error",
			message: JSON.stringify({ error: { message: "quota exceeded" } }),
		});
		expect(codex.parseEvents(stdout).message).toBe("quota exceeded");
	});

	test("prefers a real agent_message over an earlier turn.failed fallback", () => {
		const stdout = jsonl(
			{ type: "turn.failed", error: { message: "transient retrying" } },
			{ type: "item.completed", item: { type: "agent_message", text: "recovered" } },
		);
		expect(codex.parseEvents(stdout).message).toBe("recovered");
	});

	test("treats an empty agent_message text as falsy and falls back to the error", () => {
		const stdout = jsonl(
			{ type: "item.completed", item: { type: "agent_message", text: "" } },
			{ type: "error", message: "boom" },
		);
		expect(codex.parseEvents(stdout).message).toBe("boom");
	});
});
