import {
	isDgToolName,
	isPwExtCliResult,
	PW_EXT_DEFAULT_TIMEOUT_MS,
	PW_EXT_MAX_TAB_ID,
	PW_EXT_NO_TAB_ERROR,
	type PwExtCliRequest,
	type PwExtCliResult,
	type PwExtRequest,
	type PwExtTool,
	validatePwExtResponse,
} from "@dg/common";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
	CallToolRequestSchema,
	ErrorCode,
	ListToolsRequestSchema,
	McpError,
	type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { DG_AGENT_PACKAGE_VERSION } from "../version";

export const MAX_TAB_LOOKUPS = 20;
export const MAX_IN_FLIGHT = 2;
export const MAX_RECONNECTS = 1;
const REQUEST_TIMEOUT_MS = PW_EXT_DEFAULT_TIMEOUT_MS + 5_000;
const NEEDS_NEWER_EXTENSION =
	"dg-agent mcp needs a newer dg-ai-extension; update and reload it";
const LOST_SESSION = "dg-agent mcp lost its session; restart it.";
const TAB_LINE = /^- (?:\[selected\] )?(\d+): /;
const TAB_DESCRIPTION =
	"Tab id from pw --ext tabs. Needed when several tabs expose this tool.";

export class McpLinkClosedError extends Error {
	constructor(readonly submitted = true) {
		super("dg-daemon closed the CLI connection");
	}
}

class CallInterruptedError extends Error {
	constructor(tool: string) {
		super(
			`The connection closed before the result arrived; ${tool} may have run. Check the mailbox before you retry.`,
		);
	}
}

class CanceledError extends Error {
	constructor() {
		super("The request was canceled.");
	}
}

class LostSessionError extends Error {
	constructor() {
		super(LOST_SESSION);
	}
}

export type McpLink = {
	cancel(requestId: string): void;
	request(
		frame: PwExtCliRequest,
		accept: (value: unknown) => value is PwExtCliResult,
		timeoutMs: number,
	): Promise<PwExtCliResult>;
	close(): void;
};

export type DgMcpDeps = {
	connect(): Promise<McpLink>;
	now(): number;
};

type Exposure = { tool: PwExtTool; tabs: number[] };

function parseTabIds(text: string): number[] {
	const ids = new Set<number>();
	for (const line of text.split("\n")) {
		const match = TAB_LINE.exec(line);
		const id = match ? Number(match[1]) : Number.NaN;
		if (Number.isSafeInteger(id) && id <= PW_EXT_MAX_TAB_ID) ids.add(id);
	}
	return [...ids];
}

function parseSchema(raw: string | undefined): { schema: Record<string, unknown>; properties: Record<string, unknown> } {
	let schema: Record<string, unknown> = { type: "object" };
	try {
		const parsed: unknown = JSON.parse(raw ?? "");
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
			schema = parsed as Record<string, unknown>;
	} catch {}
	const existing = schema.properties;
	const properties =
		typeof existing === "object" && existing !== null && !Array.isArray(existing)
			? (existing as Record<string, unknown>)
			: {};
	return { schema, properties };
}

/** The argument that picks the tab: the first of tab, dg_tab, dg_tab_2, … that the tool does not use. */
function tabKey(raw: string | undefined): string {
	const { properties } = parseSchema(raw);
	if (!Object.hasOwn(properties, "tab")) return "tab";
	let key = "dg_tab";
	for (let n = 2; Object.hasOwn(properties, key); n++) key = `dg_tab_${n}`;
	return key;
}

function withTabProperty(raw: string | undefined): Tool["inputSchema"] {
	const { schema, properties } = parseSchema(raw);
	return {
		...schema,
		type: "object",
		properties: { ...properties, [tabKey(raw)]: { type: "integer", description: TAB_DESCRIPTION } } as Record<string, object>,
	};
}

function failure(text: string) {
	return { isError: true, content: [{ type: "text" as const, text }] };
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The dg-agent MCP server: dg_ tools of the agent's tabs, called through the daemon relay. */
export function createDgMcpServer({ connect, now }: DgMcpDeps): Server {
	const server = new Server(
		{ name: "dg-agent", version: DG_AGENT_PACKAGE_VERSION },
		{ capabilities: { tools: {} } },
	);
	let link: Promise<McpLink> | undefined;
	let closes = 0;
	let lost = false;
	let sequence = 0;
	let listed: Map<string, Exposure> | undefined;
	let slots = MAX_IN_FLIGHT;
	const waiting: Array<() => void> = [];

	async function takeSlot(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) throw new CanceledError();
		if (slots > 0) {
			slots -= 1;
			return;
		}
		await new Promise<void>((resolve, reject) => {
			const grant = () => {
				signal?.removeEventListener("abort", abandon);
				resolve();
			};
			const abandon = () => {
				const index = waiting.indexOf(grant);
				if (index >= 0) waiting.splice(index, 1);
				reject(new CanceledError());
			};
			waiting.push(grant);
			signal?.addEventListener("abort", abandon, { once: true });
		});
	}

	function releaseSlot(): void {
		const next = waiting.shift();
		if (next) next();
		else slots += 1;
	}

	function acquire(): Promise<McpLink> {
		if (lost) return Promise.reject(new LostSessionError());
		link ??= connect().catch((error: unknown) => {
			link = undefined;
			if (closes > 0) lost = true;
			throw error;
		});
		return link;
	}

	function drop(stale: Promise<McpLink>, closed: McpLink): void {
		try {
			closed.close();
		} catch {}
		if (link !== stale) return;
		link = undefined;
		closes += 1;
		if (closes > MAX_RECONNECTS) lost = true;
	}

	async function send(request: PwExtRequest, signal?: AbortSignal): Promise<PwExtCliResult> {
		await takeSlot(signal);
		try {
			return await sendUnthrottled(request, signal);
		} finally {
			releaseSlot();
		}
	}

	function submit(
		active: McpLink,
		request: PwExtRequest,
		requestId: string,
		signal?: AbortSignal,
	): Promise<PwExtCliResult> {
		const reply = active.request(
			{ type: "cli-pw-ext-request", requestId, request },
			isPwExtCliResult(requestId),
			REQUEST_TIMEOUT_MS,
		);
		if (!signal) return reply;
		return new Promise<PwExtCliResult>((resolve, reject) => {
			const onAbort = () => {
				try {
					active.cancel(requestId);
				} catch {}
				reply.catch(() => {});
				reject(new CanceledError());
			};
			signal.addEventListener("abort", onAbort, { once: true });
			reply.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
		});
	}

	async function sendUnthrottled(
		request: PwExtRequest,
		signal?: AbortSignal,
	): Promise<PwExtCliResult> {
		for (;;) {
			const pending = acquire();
			const active = await pending;
			if (signal?.aborted) throw new CanceledError();
			sequence += 1;
			const requestId = `dg-agent-mcp-${now()}-${sequence}`;
			try {
				return await submit(active, request, requestId, signal);
			} catch (error) {
				if (!(error instanceof McpLinkClosedError)) throw error;
				drop(pending, active);
				if (request.verb === "call" && error.submitted)
					throw new CallInterruptedError(request.tool as string);
			}
		}
	}

	async function exposures(signal?: AbortSignal): Promise<Map<string, Exposure>> {
		const listing = await send({ verb: "tabs" }, signal);
		if (!listing.ok && listing.error === PW_EXT_NO_TAB_ERROR) return new Map();
		if (!listing.ok)
			throw new McpError(ErrorCode.InternalError, listing.error ?? "pw --ext tabs failed.");
		const tabs = parseTabIds(listing.data?.text ?? "").slice(0, MAX_TAB_LOOKUPS);
		const replies = await Promise.all(tabs.map(async (tabId) => ({
			tabId,
			reply: await send({ verb: "tools", tabId }, signal),
		})));
		const found = new Map<string, Exposure>();
		let firstError: string | undefined;
		let usable = 0;
		for (const { tabId, reply } of replies) {
			if (!reply.ok) {
				firstError ??= reply.error ?? "pw --ext tools failed.";
				continue;
			}
			let tools: PwExtTool[] | undefined;
			try {
				tools = validatePwExtResponse(reply.data).tools;
			} catch (error) {
				firstError ??= `Invalid reply from the extension: ${messageOf(error)}`;
				continue;
			}
			if (!tools) throw new McpError(ErrorCode.InternalError, NEEDS_NEWER_EXTENSION);
			usable += 1;
			for (const tool of tools) {
				if (!isDgToolName(tool.name)) continue;
				const entry = found.get(tool.name);
				if (entry) entry.tabs.push(tabId);
				else found.set(tool.name, { tool, tabs: [tabId] });
			}
		}
		if (firstError !== undefined && usable === 0)
			throw new McpError(ErrorCode.InternalError, firstError);
		listed = found;
		return found;
	}

	async function pickTab(
		name: string,
		key: string,
		given: unknown,
		signal?: AbortSignal,
	): Promise<number> {
		if (given !== undefined) {
			if (typeof given !== "number" || !Number.isSafeInteger(given) || given < 0 || given > PW_EXT_MAX_TAB_ID)
				throw new Error(`${key} must be a tab id from pw --ext tabs.`);
			return given;
		}
		const tabs = (await exposures(signal)).get(name)?.tabs ?? [];
		if (tabs.length === 0)
			throw new Error(`No agent tab exposes ${name}. Open the site with pw --ext new <url>.`);
		if (tabs.length > 1)
			throw new Error(`Several tabs expose ${name}: ${tabs.join(", ")}. Pass ${key}.`);
		return tabs[0] as number;
	}

	server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
		try {
			const found = await exposures(extra.signal);
			return {
				tools: [...found.values()].map(({ tool }) => ({
					name: tool.name,
					description: tool.description,
					inputSchema: withTabProperty(tool.inputSchema),
				})),
			};
		} catch (error) {
			if (error instanceof McpError) throw error;
			throw new McpError(ErrorCode.InternalError, messageOf(error));
		}
	});

	server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
		const { name } = params;
		if (!isDgToolName(name)) return failure(`${name} is not a dg tool.`);
		try {
			const all = params.arguments ?? {};
			const own = listed?.has(name) ? listed : await exposures(extra.signal);
			const key = tabKey(own.get(name)?.tool.inputSchema);
			const { [key]: tab, ...args } = all;
			const tabId = await pickTab(name, key, tab, extra.signal);
			const reply = await send({ verb: "call", tabId, tool: name, args }, extra.signal);
			if (!reply.ok) return failure(reply.error ?? `${name} failed in the browser.`);
			const { text } = validatePwExtResponse(reply.data);
			return { content: [{ type: "text" as const, text }] };
		} catch (error) {
			return failure(messageOf(error));
		}
	});

	server.onclose = () => {
		const current = link;
		link = undefined;
		lost = true;
		void current?.then((value) => value.close(), () => {});
	};
	return server;
}
