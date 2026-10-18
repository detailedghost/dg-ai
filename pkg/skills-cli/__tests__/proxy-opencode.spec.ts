import { describe, expect, test } from "bun:test";

import { opencode } from "../src/proxy/backends/opencode";
import type { BuildArgsInput } from "../src/proxy/backends/types";

function makeInput(overrides: Partial<BuildArgsInput> = {}): BuildArgsInput {
	return { prompt: "hello", ...overrides };
}

function jsonl(...events: unknown[]): string {
	return events.map((e) => JSON.stringify(e)).join("\n");
}

describe("opencode.bin", () => {
	test("is the opencode binary name", () => {
		expect(opencode.bin).toBe("opencode");
	});
});

describe("opencode.buildArgs", () => {
	test("builds the base run command with json format and permission skip", () => {
		const args = opencode.buildArgs(makeInput({ prompt: "do the thing" }));
		expect(args).toEqual(["run", "do the thing", "--format", "json", "--dangerously-skip-permissions"]);
	});

	test("appends --session when resume is provided", () => {
		const args = opencode.buildArgs(makeInput({ resume: "sess-123" }));
		expect(args).toContain("--session");
		expect(args[args.indexOf("--session") + 1]).toBe("sess-123");
	});

	test("appends --model when model is provided", () => {
		const args = opencode.buildArgs(makeInput({ model: "gpt-5" }));
		expect(args).toContain("--model");
		expect(args[args.indexOf("--model") + 1]).toBe("gpt-5");
	});

	test("appends --variant when effort is provided", () => {
		const args = opencode.buildArgs(makeInput({ effort: "high" }));
		expect(args).toContain("--variant");
		expect(args[args.indexOf("--variant") + 1]).toBe("high");
	});

	test("omits optional flags entirely when unset", () => {
		const args = opencode.buildArgs(makeInput());
		expect(args).not.toContain("--session");
		expect(args).not.toContain("--model");
		expect(args).not.toContain("--variant");
	});

	test("combines all optional flags together, preserving base-arg order", () => {
		const args = opencode.buildArgs(makeInput({ resume: "sess-1", model: "gpt-5", effort: "low" }));
		expect(args).toEqual([
			"run",
			"hello",
			"--format",
			"json",
			"--dangerously-skip-permissions",
			"--session",
			"sess-1",
			"--model",
			"gpt-5",
			"--variant",
			"low",
		]);
	});
});

describe("opencode.parseEvents", () => {
	test("returns null sessionId and empty message for empty stdout", () => {
		expect(opencode.parseEvents("")).toEqual({ sessionId: null, message: "" });
	});

	test("ignores blank lines between events", () => {
		const stdout = jsonl({ sessionID: "s1" }) + "\n\n\n" + jsonl({ type: "text", part: { text: "hi" } });
		expect(opencode.parseEvents(stdout)).toEqual({ sessionId: "s1", message: "hi" });
	});

	test("captures the first sessionID and ignores subsequent ones", () => {
		const stdout = jsonl({ sessionID: "first" }, { sessionID: "second" });
		expect(opencode.parseEvents(stdout).sessionId).toBe("first");
	});

	test("concatenates text across multiple text events in order", () => {
		const stdout = jsonl({ type: "text", part: { text: "hello " } }, { type: "text", part: { text: "world" } });
		expect(opencode.parseEvents(stdout).message).toBe("hello world");
	});

	test("skips non-text event types", () => {
		const stdout = jsonl(
			{ type: "tool", part: { text: "should not appear" } },
			{ type: "text", part: { text: "kept" } },
		);
		expect(opencode.parseEvents(stdout).message).toBe("kept");
	});

	test("skips text events whose part.text is not a string", () => {
		const stdout = jsonl(
			{ type: "text", part: { text: 42 } },
			{ type: "text", part: {} },
			{ type: "text", part: { text: "ok" } },
		);
		expect(opencode.parseEvents(stdout).message).toBe("ok");
	});

	test("skips lines that are not valid JSON without throwing", () => {
		const stdout = "not json at all\n" + jsonl({ type: "text", part: { text: "ok" } });
		expect(opencode.parseEvents(stdout)).toEqual({ sessionId: null, message: "ok" });
	});

	test("returns sessionId null when no event carries a sessionID", () => {
		const stdout = jsonl({ type: "text", part: { text: "x" } });
		expect(opencode.parseEvents(stdout).sessionId).toBeNull();
	});
});

describe("opencode.install", () => {
	test("provides an npm install hint and command", () => {
		expect(opencode.install).toEqual({
			hint: "npm package opencode-ai",
			command: "npm install -g opencode-ai",
		});
	});
});
