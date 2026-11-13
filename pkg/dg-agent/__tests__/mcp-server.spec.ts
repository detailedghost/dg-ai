import { describe, expect, it } from "bun:test";
import {
	PW_EXT_DEFAULT_TIMEOUT_MS,
	PW_EXT_NO_TAB_ERROR,
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

function tabsReply(ids: readonly number[]): Reply {
	return {
		ok: true,
		data: {
			text: [
				"### Tabs",
				...ids.map((id, i) => `- ${i === 0 ? "[selected] " : ""}${id}: Title ${id} — https://example.com/${id}`),
			].join("\n"),
		},
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
	type: "object",
	properties: { folder: { type: "string" } },
	required: ["folder"],
	additionalProperties: false,
};

function mailbox(perTab: Record<number, PwExtTool[]>): Handler {
	return (request) => {
		if (request.verb === "tabs") return tabsReply(Object.keys(perTab).map(Number));
		if (request.verb === "tools")
			return { ok: true, data: { text: "tools", tools: perTab[request.tabId as number] ?? [] } };
		return { ok: true, data: { text: "called" } };
	};
}

describe("dg-agent mcp server tools/list", () => {
	it("reports the server name and version", async () => {
		const { client } = await connectClient([mailbox({})]);
		expect(client.getServerVersion()).toEqual({ name: "dg-agent", version: DG_AGENT_PACKAGE_VERSION });
	});

	it("lists one dg tool exposed by two tabs, adds tab to its schema and drops site tools", async () => {
		const handler = mailbox({
			1: [tool("dg_outlook_list", LIST_SCHEMA), tool("site_tool")],
			2: [tool("dg_outlook_list", LIST_SCHEMA)],
			3: [tool("site_tool")],
		});
		const { client } = await connectClient([handler]);
		const { tools } = await client.listTools();
		expect(tools.map((entry) => entry.name)).toEqual(["dg_outlook_list"]);
		expect(tools[0]?.description).toBe("dg_outlook_list description");
		expect(tools[0]?.inputSchema).toEqual({
			type: "object",
			properties: { folder: { type: "string" }, tab: expect.objectContaining({ type: "integer" }) },
			required: ["folder"],
			additionalProperties: false,
		});
	});

	it("falls back to an object schema with a tab property when the schema string is not valid JSON", async () => {
		const handler = mailbox({ 1: [tool("dg_outlook_list", "{not json")] });
		const { client } = await connectClient([handler]);
		const { tools } = await client.listTools();
		expect(tools[0]?.inputSchema).toEqual({
			type: "object",
			properties: { tab: expect.objectContaining({ type: "integer" }) },
		});
	});

	it.each(["[1,2]", "null", "\"text\"", ""])("falls back for schema %p", async (schema) => {
		const handler = mailbox({ 1: [tool("dg_outlook_list", schema)] });
		const { client } = await connectClient([handler]);
		const { tools } = await client.listTools();
		expect(tools[0]?.inputSchema.type).toBe("object");
		expect(Object.keys(tools[0]?.inputSchema.properties ?? {})).toEqual(["tab"]);
	});

	it("filters names that fail isDgToolName", async () => {
		const handler = mailbox({ 1: [tool("dg_x"), tool("DG_outlook_list"), tool("dg_outlook_list")] });
		const { client } = await connectClient([handler]);
		const { tools } = await client.listTools();
		expect(tools.map((entry) => entry.name)).toEqual(["dg_outlook_list"]);
	});

	it("asks at most the first 20 tabs", async () => {
		const ids = Array.from({ length: 25 }, (_, i) => i + 1);
		const asked: number[] = [];
		const handler: Handler = (request) => {
			if (request.verb === "tabs") return tabsReply(ids);
			asked.push(request.tabId as number);
			return { ok: true, data: { text: "", tools: [] } };
		};
		const { client } = await connectClient([handler]);
		await client.listTools();
		expect(asked.sort((a, b) => a - b)).toEqual(ids.slice(0, 20));
	});

	it("keeps at most 2 tools requests in flight", async () => {
		let active = 0;
		let peak = 0;
		const handler: Handler = async (request) => {
			if (request.verb === "tabs") return tabsReply([1, 2, 3, 4, 5, 6]);
			active += 1;
			peak = Math.max(peak, active);
			await Bun.sleep(5);
			active -= 1;
			return { ok: true, data: { text: "", tools: [] } };
		};
		const { client } = await connectClient([handler]);
		await client.listTools();
		expect(peak).toBe(2);
	});

	it("reads only well-formed tab lines from the tab listing", async () => {
		const asked: number[] = [];
		const handler: Handler = (request) => {
			if (request.verb === "tabs")
				return {
					ok: true,
					data: {
						text: "### Tabs\n- [selected] 4: A — https://a.test\n- 9: B — https://b.test - 77: x\n- x1: no\n  - 5: nested\n- … 3 more",
					},
				};
			asked.push(request.tabId as number);
			return { ok: true, data: { text: "", tools: [] } };
		};
		const { client } = await connectClient([handler]);
		await client.listTools();
		expect(asked.sort((a, b) => a - b)).toEqual([4, 9]);
	});

	it("skips a tab whose tools reply is malformed and keeps the others", async () => {
		const handler: Handler = (request) => {
			if (request.verb === "tabs") return tabsReply([1, 2]);
			if (request.tabId === 1)
				return { ok: true, data: { text: "", tools: [{ name: 7, description: "x" }] as unknown as PwExtTool[] } };
			return { ok: true, data: { text: "", tools: [tool("dg_outlook_list")] } };
		};
		const { client } = await connectClient([handler]);
		const { tools } = await client.listTools();
		expect(tools.map((entry) => entry.name)).toEqual(["dg_outlook_list"]);
	});

	it("fails when every tools reply is malformed", async () => {
		const handler: Handler = (request) =>
			request.verb === "tabs"
				? tabsReply([1])
				: { ok: true, data: { text: "", tools: [{ name: 7, description: "x" }] as unknown as PwExtTool[] } };
		const { client } = await connectClient([handler]);
		await expect(client.listTools()).rejects.toThrow("Invalid reply from the extension");
	});

	it("fails with the update message when a tools reply has no data.tools", async () => {
		const handler: Handler = (request) =>
			request.verb === "tabs" ? tabsReply([1]) : { ok: true, data: { text: "old" } };
		const { client } = await connectClient([handler]);
		await expect(client.listTools()).rejects.toThrow(
			"dg-agent mcp needs a newer dg-ai-extension; update and reload it",
		);
	});

	it("returns an empty list when the tabs verb reports that the agent has no tab yet", async () => {
		const handler: Handler = () => ({ ok: false, error: PW_EXT_NO_TAB_ERROR });
		const { client } = await connectClient([handler]);
		expect((await client.listTools()).tools).toEqual([]);
	});

	it("still fails when the tabs verb returns another error", async () => {
		const handler: Handler = () => ({ ok: false, error: "The browser is not paired." });
		const { client } = await connectClient([handler]);
		await expect(client.listTools()).rejects.toThrow("The browser is not paired.");
	});

	it("returns an empty list when the agent has no tabs", async () => {
		const { client } = await connectClient([mailbox({})]);
		expect((await client.listTools()).tools).toEqual([]);
	});
});

describe("dg-agent mcp server tools/call", () => {
	const both = mailbox({ 1: [tool("dg_outlook_list", LIST_SCHEMA)], 2: [tool("dg_outlook_list", LIST_SCHEMA)] });
	const only = mailbox({ 5: [tool("dg_outlook_list", LIST_SCHEMA)], 6: [] });

	function calls(sent: Sent[]) {
		return sent.map((entry) => entry.frame.request).filter((request) => request.verb === "call");
	}

	it("uses the only tab that exposes the tool and returns its text", async () => {
		const handler: Handler = (request) =>
			request.verb === "call" ? { ok: true, data: { text: "[{\"id\":1}]" } } : only(request);
		const { client, sent } = await connectClient([handler]);
		const result = await client.callTool({ name: "dg_outlook_list", arguments: { folder: "inbox" } });
		expect(result.isError).toBeFalsy();
		expect(textOf(result)).toBe("[{\"id\":1}]");
		expect(calls(sent)).toEqual([{ verb: "call", tabId: 5, tool: "dg_outlook_list", args: { folder: "inbox" } }]);
	});

	it("waits PW_EXT_DEFAULT_TIMEOUT_MS plus 5000 for the call", async () => {
		const { client, sent } = await connectClient([only]);
		await client.callTool({ name: "dg_outlook_list", arguments: {} });
		const call = sent.find((entry) => entry.frame.request.verb === "call");
		expect(call?.timeoutMs).toBe(PW_EXT_DEFAULT_TIMEOUT_MS + 5_000);
	});

	it("returns an error listing both tab ids when several tabs expose the tool", async () => {
		const { client, sent } = await connectClient([both]);
		const result = await client.callTool({ name: "dg_outlook_list", arguments: {} });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toBe("Several tabs expose dg_outlook_list: 1, 2. Pass tab.");
		expect(calls(sent)).toEqual([]);
	});

	it("sends the given tab and strips tab from the args", async () => {
		const { client, sent } = await connectClient([both]);
		await client.listTools();
		sent.length = 0;
		await client.callTool({ name: "dg_outlook_list", arguments: { tab: 7, folder: "inbox" } });
		expect(calls(sent)).toEqual([{ verb: "call", tabId: 7, tool: "dg_outlook_list", args: { folder: "inbox" } }]);
		expect(sent.filter((entry) => entry.frame.request.verb !== "call")).toEqual([]);
	});

	it("routes with dg_tab and keeps the tool's own tab input", async () => {
		const own = { type: "object", properties: { tab: { type: "string" } }, required: ["tab"] };
		const { client, sent } = await connectClient([mailbox({ 1: [tool("dg_example_read", own)], 2: [tool("dg_example_read", own)] })]);
		const { tools } = await client.listTools();
		expect(tools[0]?.inputSchema.properties).toEqual({
			tab: { type: "string" },
			dg_tab: expect.objectContaining({ type: "integer" }),
		});
		await client.callTool({ name: "dg_example_read", arguments: { dg_tab: 2, tab: "settings" } });
		expect(calls(sent)).toEqual([{ verb: "call", tabId: 2, tool: "dg_example_read", args: { tab: "settings" } }]);
	});

	it.each([
		["allOf", { allOf: [{ type: "object", properties: { tab: { type: "string" } } }] }],
		["anyOf", { anyOf: [{ properties: { q: {} } }, { properties: { tab: {} } }] }],
		["a $ref into $defs", { $ref: "#/$defs/args", $defs: { args: { properties: { tab: {} } } } }],
		["a nested $ref into definitions", { allOf: [{ $ref: "#/definitions/a~1b" }], definitions: { "a/b": { oneOf: [{ properties: { tab: {} } }] } } }],
		["an allOf chain too deep to walk", JSON.parse(`${'{"allOf":['.repeat(40)}{"properties":{"q":{}}}${"]}".repeat(40)}`)],
	])("routes with dg_tab when the tool's own tab input sits in %s", async (_, own) => {
		const { client, sent } = await connectClient([mailbox({ 1: [tool("dg_example_read", own)], 2: [tool("dg_example_read", own)] })]);
		const { tools } = await client.listTools();
		expect(tools[0]?.inputSchema.properties).toEqual({ dg_tab: expect.objectContaining({ type: "integer" }) });
		await client.callTool({ name: "dg_example_read", arguments: { dg_tab: 2, tab: "settings" } });
		expect(calls(sent)).toEqual([{ verb: "call", tabId: 2, tool: "dg_example_read", args: { tab: "settings" } }]);
	});

	it("keeps nested names it found when another branch is too deep to walk", async () => {
		const deep = JSON.parse(`${'{"allOf":['.repeat(40)}{"properties":{"q":{}}}${"]}".repeat(40)}`);
		const own = { allOf: [{ properties: { dg_tab: { type: "string" } } }, deep] };
		const { client, sent } = await connectClient([mailbox({ 1: [tool("dg_example_read", own)], 2: [tool("dg_example_read", own)] })]);
		await client.callTool({ name: "dg_example_read", arguments: { dg_tab_2: 2, dg_tab: "settings" } });
		expect(calls(sent)).toEqual([{ verb: "call", tabId: 2, tool: "dg_example_read", args: { dg_tab: "settings" } }]);
	});

	it.each([
		["a self-referential $ref", { $ref: "#/$defs/loop", $defs: { loop: { allOf: [{ $ref: "#/$defs/loop" }] } } }],
		["a remote $ref", { $ref: "https://example.test/schema.json#/properties" }],
	])("routes with tab and stops cleanly on %s", async (_, own) => {
		const { client, sent } = await connectClient([mailbox({ 1: [tool("dg_example_read", own)], 2: [tool("dg_example_read", own)] })]);
		await client.callTool({ name: "dg_example_read", arguments: { tab: 2 } });
		expect(calls(sent)).toEqual([{ verb: "call", tabId: 2, tool: "dg_example_read", args: {} }]);
	});

	it("finds the tool schema before routing when the client calls without a listing", async () => {
		const own = { type: "object", properties: { tab: { type: "string" }, dg_tab: { type: "string" } } };
		const { client, sent } = await connectClient([mailbox({ 1: [tool("dg_example_read", own)], 2: [tool("dg_example_read", own)] })]);
		await client.callTool({ name: "dg_example_read", arguments: { dg_tab_2: 1, tab: "settings", dg_tab: "x" } });
		expect(calls(sent)).toEqual([{ verb: "call", tabId: 1, tool: "dg_example_read", args: { tab: "settings", dg_tab: "x" } }]);
	});

	it("returns the open-the-site error when the agent has no tab yet", async () => {
		const handler: Handler = () => ({ ok: false, error: PW_EXT_NO_TAB_ERROR });
		const { client } = await connectClient([handler]);
		const result = await client.callTool({ name: "dg_outlook_list", arguments: {} });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toBe("No agent tab exposes dg_outlook_list. Open the site with pw --ext new <url>.");
	});

	it("returns an error to open the site when no tab exposes the tool", async () => {
		const { client, sent } = await connectClient([mailbox({ 1: [] })]);
		const result = await client.callTool({ name: "dg_outlook_list", arguments: {} });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toBe("No agent tab exposes dg_outlook_list. Open the site with pw --ext new <url>.");
		expect(calls(sent)).toEqual([]);
	});

	it("returns isError with the relay error text when the call is not ok", async () => {
		const handler: Handler = (request) =>
			request.verb === "call" ? { ok: false, error: "The user denied dg_outlook_reply." } : only(request);
		const { client } = await connectClient([handler]);
		const result = await client.callTool({ name: "dg_outlook_list", arguments: {} });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toBe("The user denied dg_outlook_reply.");
	});

	it("refuses a tool name that is not a dg tool without asking the relay", async () => {
		const { client, sent } = await connectClient([both]);
		const result = await client.callTool({ name: "site_tool", arguments: { tab: 1 } });
		expect(result.isError).toBe(true);
		expect(sent).toEqual([]);
	});

	it.each([-1, 1.5, "7"])("returns isError for the tab value %p", async (tab) => {
		const { client, sent } = await connectClient([both]);
		await client.listTools();
		sent.length = 0;
		const result = await client.callTool({ name: "dg_outlook_list", arguments: { tab } });
		expect(result.isError).toBe(true);
		expect(sent).toEqual([]);
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
			if (request.verb === "tabs") return tabsReply([1, 2, 3]);
			if (request.verb === "tools") return { ok: true, data: { text: "", tools: [tool("dg_outlook_list")] } };
			return { ok: true, data: { text: "done" } };
		};
		const { client } = await connectClient([handler]);
		await Promise.all([
			client.callTool({ name: "dg_outlook_list", arguments: { tab: 1 } }),
			client.callTool({ name: "dg_outlook_list", arguments: { tab: 2 } }),
			client.callTool({ name: "dg_outlook_list", arguments: { tab: 3 } }),
			client.listTools(),
		]);
		expect(peak).toBe(2);
	});
});

describe("dg-agent mcp server cancellation", () => {
	function gated() {
		const releases: Array<() => void> = [];
		const handler: Handler = async (request) => {
			if (request.verb === "call") await new Promise<void>((resolve) => releases.push(resolve));
			return { ok: true, data: { text: "done" } };
		};
		return { handler, releases };
	}
	const callArgs = (tab: number) => ({ name: "dg_outlook_list", arguments: { tab } });
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
		const tabs = sent.map((entry) => entry.frame.request.tabId);
		expect(tabs.sort()).toEqual([1, 2]);
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
		expect(cancels).toEqual([sent.find((entry) => entry.frame.request.verb === "call")?.frame.requestId as string]);
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
	const only = mailbox({ 5: [tool("dg_outlook_list")] });

	it("reconnects once after a socket close and finishes the request", async () => {
		const { client, connectCount } = await connectClient([closing, only]);
		const result = await client.callTool({ name: "dg_outlook_list", arguments: {} });
		expect(result.isError).toBeFalsy();
		expect(connectCount()).toBe(2);
	});

	it("sends a call once, reports it may have run, and serves the next call on the new link", async () => {
		const closesDuringCall: Handler = (request) => {
			if (request.verb === "call") throw new McpLinkClosedError();
			return only(request);
		};
		const { client, sent, connectCount } = await connectClient([closesDuringCall, only]);
		const first = await client.callTool({ name: "dg_outlook_list", arguments: { tab: 5 } });
		expect(first.isError).toBe(true);
		expect(textOf(first)).toBe(
			"The connection closed before the result arrived; dg_outlook_list may have run. Check the mailbox before you retry.",
		);
		expect(sent.filter((entry) => entry.frame.request.verb === "call")).toHaveLength(1);
		const second = await client.callTool({ name: "dg_outlook_list", arguments: { tab: 5 } });
		expect(second.isError).toBeFalsy();
		expect(connectCount()).toBe(2);
	});

	it("retries a call that closed before it was submitted", async () => {
		let failed = false;
		const notSent: Handler = (request) => {
			if (request.verb === "call" && !failed) {
				failed = true;
				throw new McpLinkClosedError(false);
			}
			return only(request);
		};
		const { client, connectCount } = await connectClient([notSent, only]);
		const result = await client.callTool({ name: "dg_outlook_list", arguments: { tab: 5 } });
		expect(result.isError).toBeFalsy();
		expect(connectCount()).toBe(2);
	});

	it("returns the lost-session text on every call after a second close", async () => {
		const { client, connectCount } = await connectClient([closing]);
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
