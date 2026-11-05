import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { pwExtConsoleHook, pwExtWebMcp } from "@/lib/features/pw-ext-main";

let window: Window;
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");

beforeEach(() => {
	window = new Window({ url: "https://app.example.test/" });
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: window.document,
	});
});

afterEach(async () => {
	if (originalDocument)
		Object.defineProperty(globalThis, "document", originalDocument);
	else delete (globalThis as { document?: unknown }).document;
	await window.happyDOM.close();
});

function pageConsole(): Console {
	const target = window as unknown as { console: Console };
	const calls: unknown[][] = [];
	target.console = {
		warn: (...args: unknown[]) => calls.push(["warn", ...args]),
		error: (...args: unknown[]) => calls.push(["error", ...args]),
		log: () => {},
	} as unknown as Console;
	return target.console;
}

describe("console hook", () => {
	it("records warn and error after the first call, once per document", () => {
		const console = pageConsole();
		console.warn("before");
		expect(pwExtConsoleHook()).toEqual({ entries: [] });
		const wrapped = console.warn;
		expect(pwExtConsoleHook()).toEqual({ entries: [] });
		expect(console.warn).toBe(wrapped);
		console.warn("careful", 3);
		console.error(new Error("broke"));
		console.error({ a: 1 });
		expect(pwExtConsoleHook()).toEqual({
			entries: ["[warning] careful 3", "[error] broke", '[error] {"a":1}'],
		});
	});

	it("bounds the buffer and each entry", () => {
		const console = pageConsole();
		pwExtConsoleHook();
		for (let i = 0; i < 80; i++) console.warn(`w${i}`, "x".repeat(2000));
		const { entries } = pwExtConsoleHook() as { entries: string[] };
		expect(entries).toHaveLength(50);
		expect(entries[0]).toStartWith("[warning] w30 ");
		expect(entries.every((entry) => entry.length <= 520)).toBe(true);
	});
});

type FakeTool = {
	name: string;
	description: string;
	inputSchema?: object;
	annotations?: object;
	window?: unknown;
	origin?: string;
};

function installModelContext(tools: FakeTool[], output = "done") {
	const executed: unknown[][] = [];
	Object.defineProperty(window.document, "modelContext", {
		configurable: true,
		value: {
			getTools: async () => tools,
			executeTool: async (tool: FakeTool, args: object) => {
				executed.push([tool.name, args]);
				return output;
			},
		},
	});
	return executed;
}

describe("WebMCP", () => {
	it("returns an empty list when the page has no WebMCP", async () => {
		expect(await pwExtWebMcp({ kind: "tools" })).toEqual({
			api: "none",
			tools: [],
		});
	});

	it("lists tools without the window and with a capped schema", async () => {
		installModelContext([
			{
				name: "search",
				description: "Search issues",
				inputSchema: { type: "object", properties: { q: { type: "string" } } },
				annotations: { readOnlyHint: true },
				window: {},
				origin: "https://app.example.test",
			},
			{ name: "huge", description: "d".repeat(5000), inputSchema: { x: "y".repeat(50_000) } },
		]);
		const result = (await pwExtWebMcp({ kind: "tools" })) as {
			api: string;
			tools: Record<string, string>[];
		};
		expect(result.api).toBe("modelContext");
		expect(result.tools[0]).toEqual({
			name: "search",
			description: "Search issues",
			inputSchema: '{"type":"object","properties":{"q":{"type":"string"}}}',
			annotations: '{"readOnlyHint":true}',
		});
		expect(result.tools[1]?.description.length).toBeLessThanOrEqual(1001);
		expect(result.tools[1]?.inputSchema.length).toBeLessThanOrEqual(4001);
	});

	it("calls one tool by name with the given args", async () => {
		const executed = installModelContext(
			[{ name: "search", description: "Search" }],
			"3 results",
		);
		expect(
			await pwExtWebMcp({ kind: "call", tool: "search", args: { q: "bug" }, timeoutMs: 1000 }),
		).toEqual({ api: "modelContext", output: "3 results" });
		expect(executed).toEqual([["search", { q: "bug" }]]);
	});

	it("refuses an unknown tool and reports a tool failure", async () => {
		installModelContext([{ name: "search", description: "Search" }]);
		expect(
			await pwExtWebMcp({ kind: "call", tool: "delete_all", args: {}, timeoutMs: 1000 }),
		).toEqual({ error: expect.stringContaining("No WebMCP tool") });
		Object.defineProperty(window.document, "modelContext", {
			configurable: true,
			value: {
				getTools: async () => [{ name: "search", description: "Search" }],
				executeTool: async () => {
					throw new Error("tool exploded");
				},
			},
		});
		expect(
			await pwExtWebMcp({ kind: "call", tool: "search", args: {}, timeoutMs: 1000 }),
		).toEqual({ error: expect.stringContaining("tool exploded") });
	});

	it("times out a tool that never answers", async () => {
		Object.defineProperty(window.document, "modelContext", {
			configurable: true,
			value: {
				getTools: async () => [{ name: "slow", description: "Slow" }],
				executeTool: () => new Promise(() => {}),
			},
		});
		expect(
			await pwExtWebMcp({ kind: "call", tool: "slow", args: {}, timeoutMs: 50 }),
		).toEqual({ error: expect.stringContaining("timed out") });
	});

	it("falls back to the legacy testing API", async () => {
		const executed: unknown[] = [];
		Object.defineProperty(window.navigator, "modelContextTesting", {
			configurable: true,
			value: {
				listTools: async () => [{ name: "legacy", description: "Old", inputSchema: "{}" }],
				executeTool: async (name: string, input: string) => {
					executed.push([name, input]);
					return "ok";
				},
			},
		});
		expect(await pwExtWebMcp({ kind: "tools" })).toEqual({
			api: "modelContextTesting",
			tools: [{ name: "legacy", description: "Old", inputSchema: "{}" }],
		});
		expect(
			await pwExtWebMcp({ kind: "call", tool: "legacy", args: { a: 1 }, timeoutMs: 1000 }),
		).toEqual({ api: "modelContextTesting", output: "ok" });
		expect(executed).toEqual([["legacy", '{"a":1}']]);
	});
});
