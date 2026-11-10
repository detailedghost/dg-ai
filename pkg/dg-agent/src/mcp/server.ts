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

class LostSessionError extends Error {
	constructor() {
		super(LOST_SESSION);
	}
}

export type McpLink = {
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

function withTabProperty(raw: string | undefined): Tool["inputSchema"] {
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
	return {
		...schema,
		type: "object",
		properties: { ...properties, tab: { type: "integer", description: TAB_DESCRIPTION } },
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
	let slots = MAX_IN_FLIGHT;
	const waiting: Array<() => void> = [];

	async function takeSlot(): Promise<void> {
		if (slots > 0) {
			slots -= 1;
			return;
		}
		await new Promise<void>((resolve) => waiting.push(resolve));
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

	async function send(request: PwExtRequest): Promise<PwExtCliResult> {
		await takeSlot();
		try {
			return await sendUnthrottled(request);
		} finally {
			releaseSlot();
		}
	}

	async function sendUnthrottled(request: PwExtRequest): Promise<PwExtCliResult> {
		for (;;) {
			const pending = acquire();
			const active = await pending;
			sequence += 1;
			const requestId = `dg-agent-mcp-${now()}-${sequence}`;
			try {
				return await active.request(
					{ type: "cli-pw-ext-request", requestId, request },
					isPwExtCliResult(requestId),
					REQUEST_TIMEOUT_MS,
				);
			} catch (error) {
				if (!(error instanceof McpLinkClosedError)) throw error;
				drop(pending, active);
				if (request.verb === "call" && error.submitted)
					throw new CallInterruptedError(request.tool as string);
			}
		}
	}

	async function exposures(): Promise<Map<string, Exposure>> {
		const listing = await send({ verb: "tabs" });
		if (!listing.ok && listing.error === PW_EXT_NO_TAB_ERROR) return new Map();
		if (!listing.ok)
			throw new McpError(ErrorCode.InternalError, listing.error ?? "pw --ext tabs failed.");
		const tabs = parseTabIds(listing.data?.text ?? "").slice(0, MAX_TAB_LOOKUPS);
		const replies = await Promise.all(tabs.map(async (tabId) => ({
			tabId,
			reply: await send({ verb: "tools", tabId }),
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
		return found;
	}

	async function pickTab(name: string, given: unknown): Promise<number> {
		if (given !== undefined) {
			if (typeof given !== "number" || !Number.isSafeInteger(given) || given < 0 || given > PW_EXT_MAX_TAB_ID)
				throw new Error("tab must be a tab id from pw --ext tabs.");
			return given;
		}
		const tabs = (await exposures()).get(name)?.tabs ?? [];
		if (tabs.length === 0)
			throw new Error(`No agent tab exposes ${name}. Open the site with pw --ext new <url>.`);
		if (tabs.length > 1)
			throw new Error(`Several tabs expose ${name}: ${tabs.join(", ")}. Pass tab.`);
		return tabs[0] as number;
	}

	server.setRequestHandler(ListToolsRequestSchema, async () => {
		try {
			const found = await exposures();
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

	server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
		const { name } = params;
		if (!isDgToolName(name)) return failure(`${name} is not a dg tool.`);
		try {
			const { tab, ...args } = params.arguments ?? {};
			const tabId = await pickTab(name, tab);
			const reply = await send({ verb: "call", tabId, tool: name, args });
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
