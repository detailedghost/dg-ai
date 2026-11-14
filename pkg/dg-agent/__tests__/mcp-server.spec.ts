import { describe, expect, it } from "bun:test";
import {
	PW_EXT_DEFAULT_TIMEOUT_MS,
	type PwExtCliRequest,
	type PwExtCliResult,
	type PwExtRequest,
	type PwExtTool,
} from "@dg/common";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
	createDgMcpServer,
	type McpLink,
	McpLinkClosedError,
} from "../src/mcp/server";
import { DG_AGENT_PACKAGE_VERSION } from "../src/version";

type Reply =
	| { ok: true; data: { text: string; tools?: PwExtTool[] } }
	| { ok: false; error: string };
type Handler = (request: PwExtRequest) => Reply | Promise<Reply>;

type Sent = { frame: PwExtCliRequest; timeoutMs: number };

function tool(name: string, schema?: unknown): PwExtTool {
	return {
		name,
		description: `${name} description`,
		...(schema === undefined ? {} : { inputSchema: typeof schema === "string" ? schema : JSON.stringify(schema) }),
	};
}

function fakeLink(handler: Handler, sent: Sent[], cancels: string[]): McpLink {
	return {
		async request(frame, accept, timeoutMs) {
			sent.push({ frame, timeoutMs });
			const reply = await handler(frame.request);
			const result: PwExtCliResult = {
				type: "cli-pw-ext-result",
				sessionId: "s1",
				requestId: frame.requestId,
				...reply,
			};
			if (!accept(result)) throw new Error("reply rejected");
			return result;
		},
		cancel(requestId) {
			cancels.push(requestId);
		},
		close() {},
	};
}

async function connectClient(handlers: Handler[], overrides: { connects?: () => void } = {}) {
	const sent: Sent[] = [];
	const cancels: string[] = [];
	let connects = 0;
	const server = createDgMcpServer({
		connect: async () => {
			overrides.connects?.();
			const handler = handlers[Math.min(connects, handlers.length - 1)] as Handler;
			connects += 1;
			return fakeLink(handler, sent, cancels);
		},
		now: () => 1_700_000_000_000,
	});
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test", version: "0" });
	await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
	return { client, sent, cancels, connectCount: () => connects };
}

function textOf(result: unknown): string {
	const content = (result as { content: { type: string; text: string }[] }).content;
	return content.map((part) => part.text).join("");
}

const LIST_SCHEMA = {
	type: "object" as const,
	properties: { folder: { type: "string" } },
	required: ["folder"],
	additionalProperties: false,
};

function browser(tools: PwExtTool[]): Handler {
	return (request) => {
		if (request.verb === "webmcp-tools") return { ok: true, data: { text: "tools", tools } };
		return { ok: true, data: { text: "called" } };
	};
}

function verbs(sent: Sent[]): string[] {
	return sent.map((entry) => entry.frame.request.verb);
}

describe("dg-agent mcp server tools/list", () => {
	it("reports the server name and version", async () => {
		const { client } = await connectClient([browser([])]);
		expect(client.getServerVersion()).toEqual({ name: "dg-agent", version: DG_AGENT_PACKAGE_VERSION });
	});

	it("lists the dg tools of the person's tabs with one webmcp-tools request and drops site tools", async () => {
		const { client, sent } = await connectClient([browser([tool("dg_outlook_list", LIST_SCHEMA), tool("site_tool")])]);
		const { tools } = await client.listTools();
		expect(tools.map((entry) => entry.name)).toEqual(["dg_outlook_list"]);
		expect(tools[0]?.description).toBe("dg_outlook_list description");
		expect(tools[0]?.inputSchema).toEqual(LIST_SCHEMA);
		expect(sent.map((entry) => entry.frame.request)).toEqual([{ verb: "webmcp-tools" }]);
	});

	it.each(["{not json", "[1,2]", "null", "\"text\"", ""])("falls back to an object schema for %p", async (schema) => {
		const { client } = await connectClient([browser([tool("dg_outlook_list", schema)])]);
		const { tools } = await client.listTools();
		expect(tools[0]?.inputSchema).toEqual({ type: "object" });
	});

	it("filters names that fail isDgToolName", async () => {
		const { client } = await connectClient([browser([tool("dg_x"), tool("DG_outlook_list"), tool("dg_outlook_list")])]);
		const { tools } = await client.listTools();
		expect(tools.map((entry) => entry.name)).toEqual(["dg_outlook_list"]);
	});

	it("fails when the tools reply is malformed", async () => {
		const handler: Handler = () => ({
			ok: true,
			data: { text: "", tools: [{ name: 7, description: "x" }] as unknown as PwExtTool[] },
		});
		const { client } = await connectClient([handler]);
		await expect(client.listTools()).rejects.toThrow("Invalid reply from the extension");
	});

	it("fails with the update message when the reply has no data.tools", async () => {
		const { client } = await connectClient([() => ({ ok: true, data: { text: "old" } })]);
		await expect(client.listTools()).rejects.toThrow(
			"dg-agent mcp needs a newer dg-ai-extension; update and reload it",
		);
	});

	it("fails with the relay error", async () => {
		const { client } = await connectClient([() => ({ ok: false, error: "The browser is not paired." })]);
		await expect(client.listTools()).rejects.toThrow("The browser is not paired.");
	});

	it("returns an empty list when no tab exposes a dg tool", async () => {
		const { client } = await connectClient([browser([])]);
		expect((await client.listTools()).tools).toEqual([]);
	});
});

describe("dg-agent mcp server tools/call", () => {
	const listed = browser([tool("dg_outlook_list", LIST_SCHEMA)]);

	function calls(sent: Sent[]) {
		return sent.map((entry) => entry.frame.request).filter((request) => request.verb === "webmcp-call");
	}

	it("sends one webmcp-call with the arguments as given and returns its text", async () => {
		const handler: Handler = (request) =>
			request.verb === "webmcp-call" ? { ok: true, data: { text: "[{\"id\":1}]" } } : listed(request);
		const { client, sent } = await connectClient([handler]);
		const result = await client.callTool({ name: "dg_outlook_list", arguments: { folder: "inbox", tab: 3 } });
		expect(result.isError).toBeFalsy();
		expect(textOf(result)).toBe("[{\"id\":1}]");
		expect(sent.map((entry) => entry.frame.request)).toEqual([
			{ verb: "webmcp-call", tool: "dg_outlook_list", args: { folder: "inbox", tab: 3 } },
		]);
	});

	it("waits PW_EXT_DEFAULT_TIMEOUT_MS plus 5000 for the call", async () => {
		const { client, sent } = await connectClient([listed]);
		await client.callTool({ name: "dg_outlook_list", arguments: {} });
		expect(calls(sent)[0]).toBeDefined();
		expect(sent[0]?.timeoutMs).toBe(PW_EXT_DEFAULT_TIMEOUT_MS + 5_000);
	});

	it("returns isError with the relay error text when the call is not ok", async () => {
		const handler: Handler = () => ({ ok: false, error: "The user denied dg_outlook_reply in the browser." });
		const { client } = await connectClient([handler]);
		const result = await client.callTool({ name: "dg_outlook_reply", arguments: {} });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toBe("The user denied dg_outlook_reply in the browser.");
	});

	it("refuses a tool name that is not a dg tool without asking the relay", async () => {
		const { client, sent } = await connectClient([listed]);
		const result = await client.callTool({ name: "site_tool", arguments: {} });
		expect(result.isError).toBe(true);
		expect(sent).toEqual([]);
	});

	it("never asks for an agent tab listing", async () => {
		const { client, sent } = await connectClient([listed]);
		await client.listTools();
		await client.callTool({ name: "dg_outlook_list", arguments: {} });
		expect(verbs(sent)).toEqual(["webmcp-tools", "webmcp-call"]);
	});
});

describe("dg-agent mcp server concurrency", () => {
	it("never has more than 2 relay requests in flight across concurrent calls and a list", async () => {
		let active = 0;
		let peak = 0;
		const handler: Handler = async (request) => {
			active += 1;
			peak = Math.max(peak, active);
			await Bun.sleep(5);
			active -= 1;
			if (request.verb === "webmcp-tools") return { ok: true, data: { text: "", tools: [tool("dg_outlook_list")] } };
			return { ok: true, data: { text: "done" } };
		};
		const { client } = await connectClient([handler]);
		await Promise.all([
			client.callTool({ name: "dg_outlook_list", arguments: { n: 1 } }),
			client.callTool({ name: "dg_outlook_list", arguments: { n: 2 } }),
			client.callTool({ name: "dg_outlook_list", arguments: { n: 3 } }),
			client.listTools(),
		]);
		expect(peak).toBe(2);
	});
});

describe("dg-agent mcp server cancellation", () => {
	function gated() {
		const releases: Array<() => void> = [];
		const handler: Handler = async (request) => {
			if (request.verb === "webmcp-call") await new Promise<void>((resolve) => releases.push(resolve));
			return { ok: true, data: { text: "done" } };
		};
		return { handler, releases };
	}
	const callArgs = (n: number) => ({ name: "dg_outlook_list", arguments: { n } });
	const until = async (check: () => boolean) => {
		for (let i = 0; i < 200 && !check(); i += 1) await Bun.sleep(5);
	};

	it("never sends a call canceled while it waits for a relay slot", async () => {
		const { handler, releases } = gated();
		const { client, sent } = await connectClient([handler]);
		const controller = new AbortController();
		const first = client.callTool(callArgs(1));
		const second = client.callTool(callArgs(2));
		await until(() => releases.length === 2);
		const third = client.callTool(callArgs(3), undefined, { signal: controller.signal });
		const outcome = third.then(() => "resolved", () => "rejected");
		await Bun.sleep(20);
		controller.abort();
		expect(await outcome).toBe("rejected");
		await Bun.sleep(20);
		releases.forEach((release) => release());
		await Promise.all([first, second]);
		await Bun.sleep(20);
		const sentCalls = sent.map((entry) => entry.frame.request.args?.n);
		expect(sentCalls.sort()).toEqual([1, 2]);
	});

	it("sends one cancel frame with the request id when a submitted call is canceled", async () => {
		const { handler, releases } = gated();
		const { client, sent, cancels } = await connectClient([handler]);
		const controller = new AbortController();
		const pending = client.callTool(callArgs(1), undefined, { signal: controller.signal });
		const outcome = pending.then(() => "resolved", () => "rejected");
		await until(() => releases.length === 1);
		controller.abort();
		expect(await outcome).toBe("rejected");
		await until(() => cancels.length > 0);
		expect(cancels).toEqual([sent.find((entry) => entry.frame.request.verb === "webmcp-call")?.frame.requestId as string]);
		releases.forEach((release) => release());
	});

	it("frees the relay slot of a canceled call for the next call", async () => {
		const { handler, releases } = gated();
		const { client } = await connectClient([handler]);
		const controllers = [new AbortController(), new AbortController()];
		const stuck = controllers.map((controller, i) =>
			client.callTool(callArgs(i + 1), undefined, { signal: controller.signal }).catch(() => undefined),
		);
		await until(() => releases.length === 2);
		controllers.forEach((controller) => controller.abort());
		await Promise.all(stuck);
		const next = client.callTool(callArgs(3));
		await until(() => releases.length === 3);
		releases[2]?.();
		expect(textOf(await next)).toBe("done");
		releases.forEach((release) => release());
	});
});

describe("dg-agent mcp server session loss", () => {
	const closing: Handler = () => {
		throw new McpLinkClosedError();
	};
	const only = browser([tool("dg_outlook_list")]);

	it("reconnects once after a socket close and finishes the request", async () => {
		const { client, connectCount } = await connectClient([closing, only]);
		expect((await client.listTools()).tools.map((entry) => entry.name)).toEqual(["dg_outlook_list"]);
		expect(connectCount()).toBe(2);
	});

	it("sends a call once, reports it may have run, and serves the next call on the new link", async () => {
		const closesDuringCall: Handler = (request) => {
			if (request.verb === "webmcp-call") throw new McpLinkClosedError();
			return only(request);
		};
		const { client, sent, connectCount } = await connectClient([closesDuringCall, only]);
		const first = await client.callTool({ name: "dg_outlook_list", arguments: {} });
		expect(first.isError).toBe(true);
		expect(textOf(first)).toBe(
			"The connection closed before the result arrived; dg_outlook_list may have run. Check the mailbox before you retry.",
		);
		expect(sent.filter((entry) => entry.frame.request.verb === "webmcp-call")).toHaveLength(1);
		const second = await client.callTool({ name: "dg_outlook_list", arguments: {} });
		expect(second.isError).toBeFalsy();
		expect(connectCount()).toBe(2);
	});

	it("retries a call that closed before it was submitted", async () => {
		let failed = false;
		const notSent: Handler = (request) => {
			if (request.verb === "webmcp-call" && !failed) {
				failed = true;
				throw new McpLinkClosedError(false);
			}
			return only(request);
		};
		const { client, connectCount } = await connectClient([notSent, only]);
		const result = await client.callTool({ name: "dg_outlook_list", arguments: {} });
		expect(result.isError).toBeFalsy();
		expect(connectCount()).toBe(2);
	});

	it("returns the lost-session text on every call after a second close", async () => {
		const unsent: Handler = () => {
			throw new McpLinkClosedError(false);
		};
		const { client, connectCount } = await connectClient([unsent]);
		for (let i = 0; i < 2; i += 1) {
			const result = await client.callTool({ name: "dg_outlook_list", arguments: {} });
			expect(result.isError).toBe(true);
			expect(textOf(result)).toBe("dg-agent mcp lost its session; restart it.");
		}
		expect(connectCount()).toBe(2);
	});

	it("fails tools/list with the lost-session text after a second close", async () => {
		const { client } = await connectClient([closing]);
		await expect(client.listTools()).rejects.toThrow("dg-agent mcp lost its session; restart it.");
	});
});
