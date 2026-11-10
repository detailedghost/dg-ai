import { isDgToolName } from "@dg/common";

export type WebMcpTool = {
	name: string;
	description: string;
	inputSchema?: object;
	annotations?: object;
	execute(args: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<string> | string;
};

export type ModelContext = {
	registerTool(tool: WebMcpTool, options?: { signal?: AbortSignal }): void;
	getTools(): Promise<WebMcpTool[]>;
	executeTool(
		tool: Pick<WebMcpTool, "name">,
		args: Record<string, unknown>,
		options?: { signal?: AbortSignal },
	): Promise<string>;
};

type DgToolRegistry = {
	unregisterAll(): void;
	names(): string[];
	track(name: string, controller: AbortController): void;
};

const REGISTRY_KEY = Symbol.for("dg.webmcp.tools");

function createShim(): ModelContext {
	const tools = new Map<string, WebMcpTool>();
	return {
		registerTool(tool, { signal } = {}) {
			if (signal?.aborted) return;
			if (tools.has(tool.name)) throw new Error(`The tool ${tool.name} is already registered.`);
			tools.set(tool.name, tool);
			signal?.addEventListener(
				"abort",
				() => {
					if (tools.get(tool.name) === tool) tools.delete(tool.name);
				},
				{ once: true },
			);
		},
		async getTools() {
			return [...tools.values()];
		},
		async executeTool({ name }, args, options) {
			const registered = tools.get(name);
			if (!registered) throw new Error(`No tool named ${name} is registered.`);
			const output = await registered.execute(args, options);
			if (typeof output !== "string") throw new TypeError(`The tool ${name} must return a string.`);
			return output;
		},
	};
}

/** Returns the page's own modelContext when it has one; otherwise defines a non-writable one. */
export function installModelContextShim(doc: Document = document): ModelContext {
	const host = doc as Document & { modelContext?: ModelContext };
	if (host.modelContext) return host.modelContext;
	const shim = createShim();
	Object.defineProperty(host, "modelContext", { value: shim, writable: false, configurable: false, enumerable: true });
	return shim;
}

function dgToolRegistry(): DgToolRegistry {
	const slot = globalThis as unknown as Record<symbol, DgToolRegistry | undefined>;
	const existing = slot[REGISTRY_KEY];
	if (existing) return existing;
	const controllers = new Map<string, AbortController>();
	const created: DgToolRegistry = {
		unregisterAll() {
			for (const controller of [...controllers.values()]) controller.abort();
			controllers.clear();
		},
		names: () => [...controllers.keys()],
		track(name, controller) {
			controllers.set(name, controller);
			controller.signal.addEventListener("abort", () => controllers.delete(name), { once: true });
		},
	};
	Object.defineProperty(slot, REGISTRY_KEY, { value: created, configurable: true });
	return created;
}

/** Registers a dg_ tool and records it so a site's own tools can displace it. */
export function registerDgTool(tool: WebMcpTool, doc: Document = document): void {
	if (!isDgToolName(tool.name)) throw new Error(`Unknown dg tool name ${tool.name}.`);
	const context = installModelContextShim(doc);
	const registry = dgToolRegistry();
	const controller = new AbortController();
	context.registerTool(tool, { signal: controller.signal });
	registry.track(tool.name, controller);
}
