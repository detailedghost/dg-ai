import {
	isDgToolName,
	isPwExtCliResult,
	PW_EXT_DEFAULT_TIMEOUT_MS,
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

export const MAX_IN_FLIGHT = 2;
export const MAX_RECONNECTS = 1;
const REQUEST_TIMEOUT_MS = PW_EXT_DEFAULT_TIMEOUT_MS + 5_000;
const NEEDS_NEWER_EXTENSION =
	"dg mcp needs a newer dg-ai-extension; update and reload it";
const LOST_SESSION = "dg mcp lost its session; restart it.";

export class McpLinkClosedError extends Error {
	constructor(readonly submitted = true) {
		super("dg daemon closed the CLI connection");
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

function inputSchemaOf(raw: string | undefined): Tool["inputSchema"] {
	let schema: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(raw ?? "");
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
			schema = parsed as Record<string, unknown>;
	} catch {}
	return { ...schema, type: "object" };
}

function failure(text: string) {
	return { isError: true, content: [{ type: "text" as const, text }] };
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The dg agent MCP server: dg_ Web MCP tools of the person's own browser tabs, called through the daemon relay. */
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
				if (request.verb === "webmcp-call" && error.submitted)
					throw new CallInterruptedError(request.tool as string);
			}
		}
	}

	async function tools(signal?: AbortSignal): Promise<PwExtTool[]> {
		const reply = await send({ verb: "webmcp-tools" }, signal);
		if (!reply.ok)
			throw new McpError(ErrorCode.InternalError, reply.error ?? "Web MCP tools failed in the browser.");
		let found: PwExtTool[] | undefined;
		try {
			found = validatePwExtResponse(reply.data).tools;
		} catch (error) {
			throw new McpError(ErrorCode.InternalError, `Invalid reply from the extension: ${messageOf(error)}`);
		}
		if (!found) throw new McpError(ErrorCode.InternalError, NEEDS_NEWER_EXTENSION);
		return found.filter((tool) => isDgToolName(tool.name));
	}

	server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
		try {
			return {
				tools: (await tools(extra.signal)).map((tool) => ({
					name: tool.name,
					description: tool.description,
					inputSchema: inputSchemaOf(tool.inputSchema),
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
			const reply = await send(
				{ verb: "webmcp-call", tool: name, args: params.arguments ?? {} },
				extra.signal,
			);
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
