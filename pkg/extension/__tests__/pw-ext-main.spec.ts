import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { DG_TOOL_NAME } from "@dg/common";
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

	it("returns raw entries and leaves all masking to the background", () => {
		const console = pageConsole();
		pwExtConsoleHook();
		console.warn("ada@clinic.test token=abc123def456 Bearer sk-abcdefgh12345678");
		expect(pwExtConsoleHook()).toEqual({
			entries: ["[warning] ada@clinic.test token=abc123def456 Bearer sk-abcdefgh12345678"],
		});
	});

	it("bounds the buffer and each entry", () => {
		const console = pageConsole();
		pwExtConsoleHook();
		for (let i = 0; i < 80; i++) console.warn(`w${i}`, "x".repeat(2000));
		const { entries } = pwExtConsoleHook() as { entries: string[] };
		expect(entries).toHaveLength(50);
		expect(entries[0]).toStartWith("[warning] w30 ");
		expect(entries.every((entry) => entry.length <= 2001 && entry.endsWith("…"))).toBe(true);
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
	function installNativeLikeModelContext(tools: FakeTool[]) {
		const executed: unknown[] = [];
		Object.defineProperty(window.document, "modelContext", {
			configurable: true,
			value: {
				getTools: async () => tools,
				executeTool: async (tool: Partial<FakeTool>) => {
					if (typeof tool.description !== "string")
						throw new TypeError(
							"Failed to read the 'description' property from 'RegisteredTool': Required member is undefined.",
						);
					executed.push(tool);
					return "native ok";
				},
			},
		});
		return executed;
	}

	it("passes the full listed tool to a native executeTool that requires description", async () => {
		const tool = { name: "search", description: "Search", inputSchema: { type: "object" } };
		const executed = installNativeLikeModelContext([tool]);
		expect(await pwExtWebMcp({ kind: "call", tool: "search", args: { q: "x" }, timeoutMs: 1000 })).toEqual({
			api: "modelContext",
			output: "native ok",
		});
		expect(executed).toEqual([tool]);
	});

	it("fails a native executeTool that gets only the tool name", async () => {
		installNativeLikeModelContext([]);
		const context = (window.document as unknown as { modelContext: object }).modelContext as {
			executeTool(tool: object): Promise<string>;
		};
		await expect(context.executeTool({ name: "search" })).rejects.toThrow("'description'");
	});

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
		expect(result.tools[1]?.description.length).toBeLessThanOrEqual(2001);
		expect(result.tools[1]?.inputSchema).toBeUndefined();
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

describe("review round 3 hardening", () => {
	it("refuses the console hook on a document other than the tab's", () => {
		pageConsole();
		expect(pwExtConsoleHook("https://other.example.test/")).toEqual({
			error: expect.stringContaining("changed"),
		});
		expect(pwExtConsoleHook("https://app.example.test/")).toEqual({ entries: [] });
	});

	it("bounds a hostile console buffer", () => {
		pageConsole();
		const key = Symbol.for("dg.pwExt.consoleHook");
		(window as unknown as Record<symbol, unknown>)[key] = Object.assign(
			Array.from({ length: 100 }, () => `Bearer secret-${"x".repeat(20_000)}`),
			{ slice: () => ["forged"] },
		);
		const result = pwExtConsoleHook() as { entries: string[] };
		expect(result.entries).toHaveLength(50);
		expect(result.entries.every((entry) => entry.length <= 2001)).toBe(true);
		expect(result.entries).not.toContain("forged");
	});

	it("returns tool text raw and bounded, for the background to mask", async () => {
		installModelContext(
			[{ name: "t", description: `Bearer sk-abcdefgh12345678 ${"d".repeat(5000)}` }],
			`Bearer sk-output-12345678 ${"o".repeat(200_000)}`,
		);
		const listed = (await pwExtWebMcp({ kind: "tools" })) as { tools: { description: string }[] };
		expect(listed.tools[0]?.description).toStartWith("Bearer sk-abcdefgh12345678 ");
		expect(listed.tools[0]?.description.length).toBeLessThanOrEqual(2001);
		expect(listed.tools[0]?.description).toEndWith("…");
		const called = (await pwExtWebMcp({ kind: "call", tool: "t", args: {}, timeoutMs: 100 })) as { output: string };
		expect(called.output).toStartWith("Bearer sk-output-12345678 ");
		expect(called.output.length).toBeLessThanOrEqual(100_001);
	});

	it("keeps an escape-heavy tool output inside the background cap", async () => {
		installModelContext([{ name: "t", description: "d" }], "\u0001".repeat(90_000));
		const called = await pwExtWebMcp({ kind: "call", tool: "t", args: {}, timeoutMs: 100 });
		expect(JSON.stringify(called).length).toBeLessThan(150_000);
		expect((called as { output: string }).output.length).toBeGreaterThan(1000);
	});

	it("stops listing tools before the result outgrows the background cap", async () => {
		installModelContext(
			Array.from({ length: 100 }, (_, i) => ({
				name: `t${i}`,
				description: "d".repeat(2000),
				inputSchema: { x: "y".repeat(7000) },
			})),
		);
		const listed = await pwExtWebMcp({ kind: "tools" });
		expect(JSON.stringify(listed).length).toBeLessThan(150_000);
		expect((listed as { tools: unknown[] }).tools.length).toBeGreaterThan(0);
	});

	it("does not run a tool when the URL changed during discovery", async () => {
		const executed: unknown[] = [];
		Object.defineProperty(window.document, "modelContext", {
			configurable: true,
			value: {
				getTools: async () => {
					window.history.pushState({}, "", "/other");
					return [{ name: "t", description: "d" }];
				},
				executeTool: async () => {
					executed.push(1);
					return "ran";
				},
			},
		});
		expect(
			await pwExtWebMcp(
				{ kind: "call", tool: "t", args: {}, timeoutMs: 100 },
				"https://app.example.test/",
			),
		).toEqual({ error: expect.stringContaining("changed") });
		expect(executed).toEqual([]);
	});

	it("times out discovery that never answers", async () => {
		Object.defineProperty(window.document, "modelContext", {
			configurable: true,
			value: { getTools: () => new Promise(() => {}), executeTool: async () => "x" },
		});
		expect(await pwExtWebMcp({ kind: "tools", timeoutMs: 50 })).toEqual({
			error: expect.stringContaining("timed out"),
		});
	});
});

describe("WebMCP dg tool registry", () => {
	const REGISTRY_KEY = Symbol.for("dg.webmcp.tools");
	const slot = globalThis as unknown as Record<symbol, unknown>;

	afterEach(() => {
		delete slot[REGISTRY_KEY];
	});

	function pageWith(dgTools: string[], siteTools: string[]) {
		const state = { dg: [...dgTools], unregistered: 0, listedAfterUnregister: [] as string[][] };
		slot[REGISTRY_KEY] = {
			unregisterAll: () => {
				state.unregistered += 1;
				state.dg = [];
			},
			names: () => [...state.dg],
		};
		Object.defineProperty(window.document, "modelContext", {
			configurable: true,
			value: {
				getTools: async () => {
					const tools = [...state.dg, ...siteTools].map((name) => ({ name, description: name }));
					if (state.unregistered) state.listedAfterUnregister.push(tools.map((tool) => tool.name));
					return tools;
				},
				executeTool: async (tool: { name: string }) => `ran ${tool.name}`,
			},
		});
		return state;
	}

	it("unregisters the dg tools before listing when the site has its own, so no dg_ name is listed", async () => {
		const state = pageWith(["dg_outlook_list", "dg_outlook_read"], ["site_tool"]);
		const result = (await pwExtWebMcp({ kind: "tools" })) as { tools: { name: string }[] };
		expect(state.unregistered).toBe(1);
		expect(result.tools.map((tool) => tool.name)).toEqual(["site_tool"]);
		expect(state.listedAfterUnregister.length).toBeGreaterThan(0);
	});

	it("keeps the dg tools when no site tool is present", async () => {
		const state = pageWith(["dg_outlook_list"], []);
		const result = (await pwExtWebMcp({ kind: "tools" })) as { tools: { name: string }[] };
		expect(state.unregistered).toBe(0);
		expect(result.tools.map((tool) => tool.name)).toEqual(["dg_outlook_list"]);
	});

	it("lists a site tool and a dg tool together when no dg registry exists", async () => {
		Object.defineProperty(window.document, "modelContext", {
			configurable: true,
			value: {
				getTools: async () => [
					{ name: "dg_outlook_list", description: "d" },
					{ name: "site_tool", description: "s" },
				],
				executeTool: async () => "x",
			},
		});
		const result = (await pwExtWebMcp({ kind: "tools" })) as { tools: { name: string }[] };
		expect(result.tools.map((tool) => tool.name)).toEqual(["dg_outlook_list", "site_tool"]);
	});

	it("does not run a dg tool that the site's own tools displaced", async () => {
		pageWith(["dg_outlook_list"], ["site_tool"]);
		expect(
			await pwExtWebMcp({ kind: "call", tool: "dg_outlook_list", args: {}, timeoutMs: 1000 }),
		).toEqual({ error: expect.stringContaining("No WebMCP tool") });
	});

	it("reports a tool a dg script registered through the shim under the modelContext api", async () => {
		const { installModelContextShim, registerDgTool } = await import("@/lib/features/webmcp-shim");
		installModelContextShim(window.document as unknown as Document);
		registerDgTool(
			{ name: "dg_outlook_list", description: "List mail", inputSchema: { type: "object" }, execute: () => "[]" },
			window.document as unknown as Document,
		);
		const listed = (await pwExtWebMcp({ kind: "tools" })) as { api: string; tools: { name: string }[] };
		expect(listed.api).toBe("modelContext");
		expect(listed.tools.map((tool) => tool.name)).toEqual(["dg_outlook_list"]);
		expect(
			await pwExtWebMcp({ kind: "call", tool: "dg_outlook_list", args: {}, timeoutMs: 1000 }),
		).toEqual({ api: "modelContext", output: "[]" });
	});

	it("inlines the same dg name regex as isDgToolName", () => {
		expect(pwExtWebMcp.toString()).toContain(DG_TOOL_NAME.source);
	});
});

describe("WebMCP schemas", () => {
	it("omits a schema over the raw limit instead of clipping it", async () => {
		installModelContext([
			{ name: "big", description: "d", inputSchema: { type: "object", note: "n".repeat(9000) } },
			{ name: "small", description: "d", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
			{ name: "hints", description: "d", annotations: { note: "n".repeat(1100) } },
		]);
		const { tools } = (await pwExtWebMcp({ kind: "tools" })) as { tools: Record<string, string>[] };
		expect(tools[0]).toEqual({ name: "big", description: "d" });
		expect(() => JSON.parse(tools[1]!.inputSchema!)).not.toThrow();
		expect(tools[2]).toEqual({ name: "hints", description: "d" });
	});

	it("returns a valid schema raw, for the background to mask", async () => {
		installModelContext([{ name: "t", description: "d", inputSchema: { default: "token=abc123def456" } }]);
		const { tools } = (await pwExtWebMcp({ kind: "tools" })) as { tools: Record<string, string>[] };
		expect(tools[0]?.inputSchema).toBe('{"default":"token=abc123def456"}');
	});
});

describe("WebMCP legacy API next to the dg shim", () => {
	const slot = globalThis as unknown as Record<symbol, unknown>;

	afterEach(() => {
		delete slot[Symbol.for("dg.webmcp.tools")];
	});

	async function pageWithShim(legacyTools: { name: string; description: string }[]) {
		const { installModelContextShim, registerDgTool } = await import("@/lib/features/webmcp-shim");
		const doc = window.document as unknown as Document;
		installModelContextShim(doc);
		registerDgTool({ name: "dg_outlook_list", description: "List", execute: () => "[]" }, doc);
		const executed: unknown[] = [];
		Object.defineProperty(window.navigator, "modelContextTesting", {
			configurable: true,
			value: {
				listTools: async () => legacyTools,
				executeTool: async (name: string, input: string) => {
					executed.push([name, input]);
					return "legacy ok";
				},
			},
		});
		return executed;
	}

	it("lets the site's legacy tools win and unregisters the dg tools", async () => {
		const executed = await pageWithShim([{ name: "site_tool", description: "Site" }]);
		expect(await pwExtWebMcp({ kind: "tools" })).toEqual({
			api: "modelContextTesting",
			tools: [{ name: "site_tool", description: "Site" }],
		});
		expect((slot[Symbol.for("dg.webmcp.tools")] as { names(): string[] }).names()).toEqual([]);
		expect(
			await pwExtWebMcp({ kind: "call", tool: "site_tool", args: { a: 1 }, timeoutMs: 1000 }),
		).toEqual({ api: "modelContextTesting", output: "legacy ok" });
		expect(executed).toEqual([["site_tool", '{"a":1}']]);
	});

	it("falls back to the shim when the legacy API lists nothing", async () => {
		await pageWithShim([]);
		const result = (await pwExtWebMcp({ kind: "tools" })) as { api: string; tools: { name: string }[] };
		expect(result.api).toBe("modelContext");
		expect(result.tools.map((tool) => tool.name)).toEqual(["dg_outlook_list"]);
	});
});
