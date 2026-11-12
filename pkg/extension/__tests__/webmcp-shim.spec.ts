import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { installModelContextShim, registerDgTool } from "@/lib/features/webmcp-shim";

type Shim = ReturnType<typeof installModelContextShim>;
type Registry = { unregisterAll(): void; names(): string[] };

const REGISTRY_KEY = Symbol.for("dg.webmcp.tools");
const registry = () => (globalThis as unknown as Record<symbol, Registry | undefined>)[REGISTRY_KEY];

let window: Window;
let doc: Document;

beforeEach(() => {
	window = new Window({ url: "https://app.example.test/" });
	doc = window.document as unknown as Document;
	delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY];
});

afterEach(async () => {
	delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY];
	await window.happyDOM.close();
});

const tool = (name: string, execute: () => unknown = () => "ok") => ({
	name,
	description: `${name} tool`,
	inputSchema: { type: "object" },
	execute: execute as () => string,
});

const names = async (shim: Shim) => (await shim.getTools()).map((entry) => entry.name);

describe("installModelContextShim", () => {
	it("returns the native modelContext untouched when the page has one", () => {
		const native = { getTools: async () => [], registerTool() {}, executeTool: async () => "" };
		Object.defineProperty(doc, "modelContext", { configurable: true, value: native });
		expect(installModelContextShim(doc)).toBe(native as never);
		expect(Object.getOwnPropertyDescriptor(doc, "modelContext")?.value).toBe(native);
	});

	it("defines a non-writable modelContext on a bare document and returns the same object twice", () => {
		const first = installModelContextShim(doc);
		expect(installModelContextShim(doc)).toBe(first);
		expect((doc as unknown as { modelContext: unknown }).modelContext).toBe(first);
		expect(() => {
			"use strict";
			(doc as unknown as { modelContext: unknown }).modelContext = {};
		}).toThrow();
		expect((doc as unknown as { modelContext: unknown }).modelContext).toBe(first);
	});

	it("does not define a global modelContext on another document", () => {
		installModelContextShim(doc);
		const other = new Window({ url: "https://other.example.test/" });
		expect((other.document as unknown as { modelContext?: unknown }).modelContext).toBeUndefined();
	});
});

describe("model context shim", () => {
	it("removes a tool from getTools when its signal aborts", async () => {
		const shim = installModelContextShim(doc);
		const controller = new AbortController();
		shim.registerTool(tool("dg_outlook_list"), { signal: controller.signal });
		expect(await names(shim)).toEqual(["dg_outlook_list"]);
		controller.abort();
		expect(await names(shim)).toEqual([]);
	});

	it("does not register a tool whose signal is already aborted", async () => {
		const shim = installModelContextShim(doc);
		shim.registerTool(tool("dg_outlook_list"), { signal: AbortSignal.abort() });
		expect(await names(shim)).toEqual([]);
	});

	it("rejects a second tool with the same name", () => {
		const shim = installModelContextShim(doc);
		shim.registerTool(tool("dg_outlook_list"));
		expect(() => shim.registerTool(tool("dg_outlook_list"))).toThrow();
	});

	it("resolves the string a tool returns, passing the args", async () => {
		const shim = installModelContextShim(doc);
		const seen: unknown[] = [];
		shim.registerTool({
			...tool("dg_outlook_list"),
			execute: async (args: unknown) => {
				seen.push(args);
				return '{"items":[]}';
			},
		} as never);
		const [listed] = await shim.getTools();
		expect(await shim.executeTool(listed as never, { limit: 5 })).toBe('{"items":[]}');
		expect(seen).toEqual([{ limit: 5 }]);
	});

	it("rejects a non-string output with a TypeError", async () => {
		const shim = installModelContextShim(doc);
		shim.registerTool(tool("dg_outlook_list", () => ({ items: [] })));
		const [listed] = await shim.getTools();
		await expect(shim.executeTool(listed as never, {})).rejects.toBeInstanceOf(TypeError);
	});

	it("runs only a tool that is registered, even when the caller forges the tool object", async () => {
		const shim = installModelContextShim(doc);
		const ran: string[] = [];
		await expect(
			shim.executeTool({ name: "dg_outlook_delete", execute: () => void ran.push("x") } as never, {}),
		).rejects.toThrow();
		expect(ran).toEqual([]);
	});
});

describe("registerDgTool", () => {
	it.each(["search_flights", "dg_x", "dg_", "DG_outlook_list"])("refuses %s", async (name) => {
		expect(() => registerDgTool(tool(name), doc)).toThrow();
		expect(await names(installModelContextShim(doc))).toEqual([]);
		expect(registry()?.names() ?? []).toEqual([]);
	});

	it("installs the shim, registers the tool and records it", async () => {
		registerDgTool(tool("dg_outlook_list"), doc);
		expect(await names(installModelContextShim(doc))).toEqual(["dg_outlook_list"]);
		expect(registry()?.names()).toEqual(["dg_outlook_list"]);
	});

	it("registers into a native modelContext without replacing it", () => {
		const registered: string[] = [];
		const native = {
			getTools: async () => [],
			executeTool: async () => "",
			registerTool: (entry: { name: string }) => void registered.push(entry.name),
		};
		Object.defineProperty(doc, "modelContext", { configurable: true, value: native });
		registerDgTool(tool("dg_outlook_list"), doc);
		expect(registered).toEqual(["dg_outlook_list"]);
		expect(Object.getOwnPropertyDescriptor(doc, "modelContext")?.value).toBe(native);
	});

	it("empties getTools after unregisterAll on two registrations", async () => {
		registerDgTool(tool("dg_outlook_list"), doc);
		registerDgTool(tool("dg_outlook_read"), doc);
		expect(registry()?.names().sort()).toEqual(["dg_outlook_list", "dg_outlook_read"]);
		registry()?.unregisterAll();
		expect(await names(installModelContextShim(doc))).toEqual([]);
		expect(registry()?.names()).toEqual([]);
	});

	it("keeps one registry across registrations", () => {
		registerDgTool(tool("dg_outlook_list"), doc);
		const first = registry();
		registerDgTool(tool("dg_outlook_read"), doc);
		expect(registry()).toBe(first);
	});
});

describe("webmcp-shim entrypoint", () => {
	it("installs the shim when the unlisted script runs", async () => {
		const globals = globalThis as unknown as { defineUnlistedScript?: unknown; document?: unknown };
		const original = Object.getOwnPropertyDescriptor(globalThis, "document");
		globals.defineUnlistedScript = (main: unknown) => main;
		Object.defineProperty(globalThis, "document", { configurable: true, value: doc });
		try {
			const entry = (await import("../entrypoints/webmcp-shim")).default as unknown as () => void;
			entry();
			expect((doc as unknown as { modelContext?: unknown }).modelContext).toBeDefined();
		} finally {
			delete globals.defineUnlistedScript;
			if (original) Object.defineProperty(globalThis, "document", original);
			else delete globals.document;
		}
	});
});
