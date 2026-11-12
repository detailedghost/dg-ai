export type PwExtTool = {
	name: string;
	title?: string;
	description: string;
	inputSchema?: string;
	annotations?: string;
};

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

/** Self-contained MAIN-world hook that records console.warn and console.error from its first call on. */
export function pwExtConsoleHook(
	expectUrl?: string,
): { entries: string[] } | { error: string } {
	try {
		if (expectUrl !== undefined && document.URL !== expectUrl)
			return { error: "The page changed; nothing was done. Retry." };
		const MAX_ENTRIES = 50;
		const MAX_CHARS = 500;
		const REDACTED = "[redacted]";
		const PATTERNS: [RegExp, string][] = [
			[/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, `Bearer ${REDACTED}`],
			[/\b(?:sk|pk|rk|ghp|gho|ghs|github_pat|glpat|xox[baprs]|AKIA)[-_A-Za-z0-9]{8,}\b/g, REDACTED],
			[/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?/g, REDACTED],
			[/((?:password|passwd|secret|token|api[-_]?key|session)\s*[:=]\s*)[^\s&,;"']+/gi, `$1${REDACTED}`],
			[/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, REDACTED],
		];
		const bounded = (value: string): string => {
			let out = value.length > 20_000 ? value.slice(0, 20_000) : value;
			for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
			out = out.replace(/\s+/g, " ");
			return out.length > MAX_CHARS ? `${out.slice(0, MAX_CHARS)}…` : out;
		};
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
					entries.push(bounded(`[${label}] ${args.map(text).join(" ")}`));
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

/** Self-contained MAIN-world WebMCP reader and caller; it runs the page's own tool code only for call. */
export async function pwExtWebMcp(
	action: PwExtWebMcpAction,
	expectUrl?: string,
): Promise<PwExtWebMcpResult> {
	const MAX_TOOLS = 100;
	const DESCRIPTION_MAX = 1000;
	const SCHEMA_MAX = 4000;
	const OUTPUT_MAX = 50_000;
	const REDACTED = "[redacted]";
	const PATTERNS: [RegExp, string][] = [
		[/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, `Bearer ${REDACTED}`],
		[/\b(?:sk|pk|rk|ghp|gho|ghs|github_pat|glpat|xox[baprs]|AKIA)[-_A-Za-z0-9]{8,}\b/g, REDACTED],
		[/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?/g, REDACTED],
		[/((?:password|passwd|secret|token|api[-_]?key|session)\s*[:=]\s*)[^\s&,;"']+/gi, `$1${REDACTED}`],
		[/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, REDACTED],
	];
	const clip = (value: string, max: number) => {
		let out = value.length > max * 4 ? value.slice(0, max * 4) : value;
		for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
		return out.length > max ? `${out.slice(0, max)}…` : out;
	};
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
	const json = (value: unknown, max: number): string | undefined => {
		if (value === undefined || value === null) return undefined;
		try {
			const out = typeof value === "string" ? value : JSON.stringify(value);
			return typeof out === "string" ? clip(out, max) : undefined;
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
	const api = modern ? "modelContext" : legacy ? "modelContextTesting" : "none";
	try {
		if (api === "none") return { api, tools: [] };
		if (changed()) return CHANGED;
		const discoveryMs = action.kind === "call" ? action.timeoutMs : (action.timeoutMs ?? 10_000);
		const raw: Raw[] = await withTimeout(
			Promise.resolve(
				modern
					? modern.getTools()
					: ((legacy?.listTools ?? legacy?.getTools)?.call(legacy) ?? []),
			),
			discoveryMs,
			"WebMCP tool discovery",
		);
		if (changed()) return CHANGED;
		const list = Array.isArray(raw) ? raw.slice(0, MAX_TOOLS) : [];
		if (action.kind === "tools") {
			const tools: PwExtTool[] = list.map((tool) => {
				const entry: PwExtTool = {
					name: clip(String(tool.name ?? ""), 128),
					description: clip(String(tool.description ?? ""), DESCRIPTION_MAX),
				};
				if (typeof tool.title === "string") entry.title = clip(tool.title, 200);
				const schema = json(tool.inputSchema, SCHEMA_MAX);
				if (schema) entry.inputSchema = schema;
				const annotations = json(tool.annotations, 500);
				if (annotations) entry.annotations = annotations;
				return entry;
			});
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
				modern
					? modern.executeTool(tool, action.args, { signal: controller.signal })
					: legacy!.executeTool(action.tool, JSON.stringify(action.args)),
				timeout,
			]);
			return {
				api,
				output: clip(json(output, OUTPUT_MAX + 1) ?? "", OUTPUT_MAX),
			};
		} finally {
			clearTimeout(timer);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { error: `WebMCP failed: ${clip(message, 500)}` };
	}
}
