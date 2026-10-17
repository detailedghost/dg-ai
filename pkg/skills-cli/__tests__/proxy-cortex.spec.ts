import { describe, expect, test } from "bun:test";

import { cortex } from "../src/proxy/backends/cortex";
import type { BuildArgsInput } from "../src/proxy/backends/types";

// ── Factories ────────────────────────────────────────────────────────────────

function makeInput(overrides: Partial<BuildArgsInput> = {}): BuildArgsInput {
	return { prompt: "do the thing", ...overrides };
}

function jsonl(...events: unknown[]): string {
	return events.map((e) => JSON.stringify(e)).join("\n");
}

// ── cortex.bin / cortex.install ────────────────────────────────────────────────

describe("cortex.bin", () => {
	test("is the cortex-code binary name", () => {
		expect(cortex.bin).toBe("cortex");
	});
});

describe("cortex.install", () => {
	test("points at the Snowflake Cortex Code CLI", () => {
		expect(cortex.install.hint).toContain("Cortex Code");
		expect(cortex.install.url).toContain("docs.snowflake.com");
	});
});

// ── cortex.buildArgs ────────────────────────────────────────────────────────────

describe("cortex.buildArgs", () => {
	test("builds a fresh-turn print invocation with stream-json and auto-approve", () => {
		const args = cortex.buildArgs(makeInput({ prompt: "hello" }));
		expect(args).toEqual([
			"--print",
			"hello",
			"--output-format",
			"stream-json",
			"--no-auto-update",
			"--dangerously-allow-all-tool-calls",
		]);
	});

	test("builds a resume invocation targeting the given session id and omits the auto-approve guard", () => {
		const args = cortex.buildArgs(
			makeInput({ prompt: "hello", resume: "sess-123" }),
		);
		expect(args).toEqual([
			"--print",
			"hello",
			"--output-format",
			"stream-json",
			"--no-auto-update",
			"--resume",
			"sess-123",
		]);
		expect(args).not.toContain("--dangerously-allow-all-tool-calls");
	});

	test("appends --model with the model when provided", () => {
		const args = cortex.buildArgs(makeInput({ model: "claude-opus-4-8" }));
		expect(args.slice(-2)).toEqual(["--model", "claude-opus-4-8"]);
	});

	test("appends --effort with the thinking level when provided", () => {
		const args = cortex.buildArgs(makeInput({ effort: "high" }));
		expect(args.slice(-2)).toEqual(["--effort", "high"]);
	});

	test("omits --model and --effort entirely when neither is provided", () => {
		const args = cortex.buildArgs(makeInput());
		expect(args).not.toContain("--model");
		expect(args).not.toContain("--effort");
	});

	test("stacks model and effort flags after the resume args, in that order", () => {
		const args = cortex.buildArgs(
			makeInput({ resume: "sess-1", model: "auto", effort: "low" }),
		);
		expect(args).toEqual([
			"--print",
			"do the thing",
			"--output-format",
			"stream-json",
			"--no-auto-update",
			"--resume",
			"sess-1",
			"--model",
			"auto",
			"--effort",
			"low",
		]);
	});
});

// ── cortex.parseEvents ──────────────────────────────────────────────────────────

describe("cortex.parseEvents", () => {
	test("extracts sessionId from the init event and message from the result event", () => {
		const stdout = jsonl(
			{ type: "system", subtype: "init", session_id: "abc" },
			{
				type: "assistant",
				session_id: "abc",
				message: { content: [{ type: "text", text: "hi there" }] },
			},
			{
				type: "result",
				subtype: "success",
				session_id: "abc",
				result: "hi there",
				is_error: false,
			},
		);
		expect(cortex.parseEvents(stdout)).toEqual({
			sessionId: "abc",
			message: "hi there",
		});
	});

	test("keeps the first session_id when the stream carries it on every event", () => {
		const stdout = jsonl(
			{ type: "system", subtype: "init", session_id: "first" },
			{
				type: "result",
				subtype: "success",
				session_id: "first",
				result: "done",
			},
		);
		expect(cortex.parseEvents(stdout).sessionId).toBe("first");
	});

	test("prefers the result event over accumulated assistant text", () => {
		const stdout = jsonl(
			{
				type: "assistant",
				message: { content: [{ type: "text", text: "streamed draft" }] },
			},
			{ type: "result", subtype: "success", result: "final answer" },
		);
		expect(cortex.parseEvents(stdout).message).toBe("final answer");
	});

	test("falls back to assistant text when no result event carries a string", () => {
		const stdout = jsonl({
			type: "assistant",
			message: { content: [{ type: "text", text: "only assistant" }] },
		});
		expect(cortex.parseEvents(stdout).message).toBe("only assistant");
	});

	test("keeps only the last assistant message text when several stream in", () => {
		const stdout = jsonl(
			{
				type: "assistant",
				message: { content: [{ type: "text", text: "first" }] },
			},
			{
				type: "assistant",
				message: { content: [{ type: "text", text: "second" }] },
			},
		);
		expect(cortex.parseEvents(stdout).message).toBe("second");
	});

	test("ignores non-text assistant content blocks such as thinking", () => {
		const stdout = jsonl(
			{
				type: "assistant",
				message: { content: [{ type: "thinking", thinking: "hmm" }] },
			},
			{ type: "result", subtype: "success", result: "answer" },
		);
		expect(cortex.parseEvents(stdout).message).toBe("answer");
	});

	test("surfaces the result text even when the run reports is_error", () => {
		const stdout = jsonl({
			type: "result",
			subtype: "error_max_turns",
			result: "hit the turn cap",
			is_error: true,
		});
		expect(cortex.parseEvents(stdout).message).toBe("hit the turn cap");
	});

	test("skips blank lines and unparseable JSON without throwing", () => {
		const stdout = [
			"",
			"   ",
			"not json{{{",
			JSON.stringify({ type: "result", result: "ok" }),
		].join("\n");
		expect(cortex.parseEvents(stdout)).toEqual({
			sessionId: null,
			message: "ok",
		});
	});

	test("returns null sessionId and empty message for empty stdout", () => {
		expect(cortex.parseEvents("")).toEqual({ sessionId: null, message: "" });
	});
});
