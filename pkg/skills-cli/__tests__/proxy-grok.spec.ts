import { describe, expect, test } from "bun:test";

import { grok } from "../src/proxy/backends/grok";
import type { BuildArgsInput } from "../src/proxy/backends/types";

function makeInput(overrides: Partial<BuildArgsInput> = {}): BuildArgsInput {
	return { prompt: "hello", ...overrides };
}

function jsonl(...events: unknown[]): string {
	return events.map((e) => JSON.stringify(e)).join("\n");
}

describe("grok.bin", () => {
	test("is the grok binary name", () => {
		expect(grok.bin).toBe("grok");
	});
});

describe("grok.install", () => {
	test("points at the Grok Build installer", () => {
		expect(grok.install.hint).toContain("Grok Build");
		expect(grok.install.command).toContain("https://x.ai/cli/install.sh");
	});
});

describe("grok.buildArgs", () => {
	test("builds a headless streaming run that auto-approves tools", () => {
		expect(grok.buildArgs(makeInput({ prompt: "do the thing" }))).toEqual([
			"-p",
			"do the thing",
			"--output-format",
			"streaming-json",
			"--yolo",
			"--no-auto-update",
		]);
	});

	test("appends resume, model, and effort when set", () => {
		const args = grok.buildArgs(makeInput({ resume: "sess-1", model: "grok-4.7", effort: "high" }));
		expect(args).toEqual([
			"-p",
			"hello",
			"--output-format",
			"streaming-json",
			"--yolo",
			"--no-auto-update",
			"--resume",
			"sess-1",
			"--model",
			"grok-4.7",
			"--effort",
			"high",
		]);
	});

	test("omits optional flags when unset", () => {
		const args = grok.buildArgs(makeInput());
		expect(args).not.toContain("--resume");
		expect(args).not.toContain("--model");
		expect(args).not.toContain("--effort");
	});
});

describe("grok.parseEvents", () => {
	test("returns empty fields for empty stdout", () => {
		expect(grok.parseEvents("")).toEqual({ sessionId: null, message: "" });
	});

	test("joins text chunks and reads the session id from the end event", () => {
		const stdout = jsonl(
			{ type: "text", data: "hello " },
			{ type: "text", data: "world" },
			{ type: "end", sessionId: "sess-9", stopReason: "end_turn" },
		);
		expect(grok.parseEvents(stdout)).toEqual({
			sessionId: "sess-9",
			message: "hello world",
		});
	});

	test("keeps the first session id", () => {
		const stdout = jsonl({ type: "end", sessionId: "first" }, { type: "end", sessionId: "second" });
		expect(grok.parseEvents(stdout).sessionId).toBe("first");
	});

	test("uses the error message when no text arrived", () => {
		const stdout = jsonl({ type: "error", message: "Couldn't start session" });
		expect(grok.parseEvents(stdout)).toEqual({
			sessionId: null,
			message: "Couldn't start session",
		});
	});

	test("prefers text over a later error message", () => {
		const stdout = jsonl({ type: "text", data: "partial" }, { type: "error", message: "boom" });
		expect(grok.parseEvents(stdout).message).toBe("partial");
	});

	test("skips lines that are not JSON", () => {
		const stdout = `not json\n${JSON.stringify({ type: "text", data: "ok" })}`;
		expect(grok.parseEvents(stdout).message).toBe("ok");
	});
});
