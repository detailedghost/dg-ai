import type { PwExtTool } from "@dg/common";

export type PwExtWebMcpAction =
	| { kind: "tools"; timeoutMs?: number }
	| {
			kind: "call";
			tool: string;
			args: Record<string, unknown>;
			timeoutMs: number;
	  };

export type PwExtWebMcpResult =
	| { api: "modelContext" | "modelContextTesting" | "none"; tools: PwExtTool[] }
	| { api: "modelContext" | "modelContextTesting"; output: string }
	| { error: string };

/** Self-contained MAIN-world hook that records console.warn and console.error from its first call on; it returns raw, bounded entries. */
export function pwExtConsoleHook(expectUrl?: string): { entries: string[] } | { error: string } {
	try {
		if (expectUrl !== undefined && document.URL !== expectUrl)
			return { error: "The page changed; nothing was done. Retry." };
		const MAX_ENTRIES = 50;
		const RAW_MAX = 2000;
		const bounded = (value: string): string =>
			value.length > RAW_MAX ? `${value.slice(0, RAW_MAX)}…` : value;
		const KEY = Symbol.for("dg.pwExt.consoleHook");
		const win = document.defaultView as unknown as Window &
			Record<symbol, unknown>;
		const existing = win[KEY] as { length?: unknown; [index: number]: unknown } | undefined;
		if (existing !== undefined && existing !== null) {
			const length = Math.min(Number(existing.length) || 0, 100_000);
			const entries: string[] = [];
			for (let i = Math.max(0, length - MAX_ENTRIES); i < length; i++) {
				const entry = existing[i];
				if (typeof entry === "string") entries.push(bounded(entry));
			}
			return { entries };
		}
		const entries: string[] = [];
		Object.defineProperty(win, KEY, { value: entries, configurable: false });
		const text = (value: unknown): string => {
			try {
				if (typeof value === "string") return value;
				if (value instanceof Error) return value.message;
				const json = JSON.stringify(value);
				return typeof json === "string" ? json : String(value);
			} catch {
				return "[unprintable]";
			}
		};
		const target = (win as unknown as { console: Console }).console as unknown as Record<
			"warn" | "error",
			(...args: unknown[]) => void
		>;
		for (const [method, label] of [
			["warn", "warning"],
			["error", "error"],
		] as const) {
			const original = target[method];
			target[method] = function (this: unknown, ...args: unknown[]) {
				try {
					entries.push(`[${label}] ${args.map(text).join(" ")}`.slice(0, 20_000));
					if (entries.length > MAX_ENTRIES) entries.shift();
				} catch {
					return original.apply(this, args);
				}
				return original.apply(this, args);
			};
		}
		return { entries: [] };
	} catch (error) {
		return { error: `Console capture failed: ${String(error).slice(0, 200)}` };
	}
}

/** Self-contained MAIN-world WebMCP reader and caller; it runs the page's own tool code only for call, and returns raw, bounded text. */
export async function pwExtWebMcp(
	action: PwExtWebMcpAction,
	expectUrl?: string,
): Promise<PwExtWebMcpResult> {
	const MAX_TOOLS = 100;
	const LIST_BUDGET = 120_000;
	const DESCRIPTION_MAX = 2000;
	const SCHEMA_MAX = 8000;
	const ANNOTATIONS_MAX = 1000;
	const OUTPUT_MAX = 100_000;
	const ENCODED_MAX = 140_000;
	const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max)}…` : value);
	const changed = () => expectUrl !== undefined && document.URL !== expectUrl;
	const CHANGED = { error: "The page changed; nothing was done. Retry." };
	const withTimeout = async <T,>(work: Promise<T>, ms: number, what: string): Promise<T> => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				work,
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms.`)), ms);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	};
	const json = (value: unknown): string => {
		if (value === undefined || value === null) return "";
		try {
			const out = typeof value === "string" ? value : JSON.stringify(value);
			return typeof out === "string" ? out : "";
		} catch {
			return "";
		}
	};
	const wholeJson = (value: unknown, max: number): string | undefined => {
		if (value === undefined || value === null) return undefined;
		try {
			const raw = typeof value === "string" ? value : JSON.stringify(value);
			if (typeof raw !== "string" || raw.length > max) return undefined;
			JSON.parse(raw);
			return raw;
		} catch {
			return undefined;
		}
	};
	type Raw = {
		name?: unknown;
		title?: unknown;
		description?: unknown;
		inputSchema?: unknown;
		annotations?: unknown;
	};
	const doc = document as Document & {
		modelContext?: {
			getTools(): Promise<Raw[]>;
			executeTool(tool: Raw, args: object, options?: object): Promise<unknown>;
		};
	};
	const nav = doc.defaultView?.navigator as
		| (Navigator & {
				modelContextTesting?: {
					listTools?(): Promise<Raw[]> | Raw[];
					getTools?(): Promise<Raw[]> | Raw[];
					executeTool(name: string, input: string): Promise<unknown>;
				};
		  })
		| undefined;
	const modern = doc.modelContext;
	const legacy = nav?.modelContextTesting;
	let useModern = Boolean(modern);
	let api: "modelContext" | "modelContextTesting" | "none" = modern ? "modelContext" : legacy ? "modelContextTesting" : "none";
	const registryOf = () =>
		(globalThis as unknown as Record<symbol, { unregisterAll?: unknown } | undefined>)[
			Symbol.for("dg.webmcp.tools")
		];
	try {
		if (api === "none") return { api, tools: [] };
		if (changed()) return CHANGED;
		const discoveryMs = action.kind === "call" ? action.timeoutMs : (action.timeoutMs ?? 10_000);
		const shimmed = (modern as object | undefined as Record<symbol, unknown> | undefined)?.[Symbol.for("dg.webmcp.shim")] === true;
		if (shimmed && legacy) {
			const legacyList = await withTimeout(
				Promise.resolve((legacy.listTools ?? legacy.getTools)?.call(legacy) ?? []),
				discoveryMs,
				"WebMCP tool discovery",
			);
			if (changed()) return CHANGED;
			if (Array.isArray(legacyList) && legacyList.length > 0) {
				useModern = false;
				api = "modelContextTesting";
				const early = registryOf();
				if (typeof early?.unregisterAll === "function") early.unregisterAll();
			}
		}
		const discover = async (): Promise<Raw[]> => {
			const raw: Raw[] = await withTimeout(
				Promise.resolve(
					useModern
						? modern!.getTools()
						: ((legacy?.listTools ?? legacy?.getTools)?.call(legacy) ?? []),
				),
				discoveryMs,
				"WebMCP tool discovery",
			);
			return Array.isArray(raw) ? raw.slice(0, MAX_TOOLS) : [];
		};
		let list = await discover();
		if (changed()) return CHANGED;
		const registry = registryOf();
		if (
			list.some((tool) => !/^dg_[a-z0-9]+_[a-z0-9_]+$/.test(String(tool.name))) &&
			typeof registry?.unregisterAll === "function"
		) {
			registry.unregisterAll();
			list = await discover();
			if (changed()) return CHANGED;
		}
		if (action.kind === "tools") {
			const tools: PwExtTool[] = [];
			let used = 0;
			for (const tool of list) {
				const entry: PwExtTool = {
					name: clip(String(tool.name ?? ""), 256),
					description: clip(String(tool.description ?? ""), DESCRIPTION_MAX),
				};
				if (typeof tool.title === "string") entry.title = clip(tool.title, 400);
				const schema = wholeJson(tool.inputSchema, SCHEMA_MAX);
				if (schema) entry.inputSchema = schema;
				const annotations = wholeJson(tool.annotations, ANNOTATIONS_MAX);
				if (annotations) entry.annotations = annotations;
				used += JSON.stringify(entry).length;
				if (used > LIST_BUDGET) break;
				tools.push(entry);
			}
			return { api, tools };
		}
		const tool = list.find((candidate) => candidate.name === action.tool);
		if (changed()) return CHANGED;
		if (!tool) return { error: `No WebMCP tool named ${clip(action.tool, 128)} on this page.` };
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				controller.abort();
				reject(new Error(`The WebMCP tool timed out after ${action.timeoutMs}ms.`));
			}, action.timeoutMs);
		});
		try {
			const output = await Promise.race([
				useModern
					? modern!.executeTool({ name: action.tool }, action.args, { signal: controller.signal })
					: legacy!.executeTool(action.tool, JSON.stringify(action.args)),
				timeout,
			]);
			let text = clip(json(output), OUTPUT_MAX);
			for (let round = 0; round < 4; round++) {
				const encoded = JSON.stringify(text).length;
				if (encoded <= ENCODED_MAX) break;
				text = clip(text, Math.floor((text.length * ENCODED_MAX) / encoded / 1.1));
			}
			return { api, output: text };
		} finally {
			clearTimeout(timer);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { error: `WebMCP failed: ${clip(message, 500)}` };
	}
}
