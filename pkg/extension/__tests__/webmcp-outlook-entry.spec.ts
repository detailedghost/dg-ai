import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { WEBMCP_TOOL_CLASSES } from "@dg/common";
import { Window } from "happy-dom";
import { registerOutlookTools, startOutlookPlugin } from "@/lib/features/webmcp-outlook/plugin";
import { installModelContextShim, type WebMcpTool } from "@/lib/features/webmcp-shim";

const REGISTRY_KEY = Symbol.for("dg.webmcp.tools");
const STARTED_KEY = Symbol.for("dg.webmcp.outlook");
const OK = { Body: { ResponseMessages: { Items: [{ ResponseClass: "Success", ResponseCode: "NoError", Items: [] }] } } };

let window: Window;
let doc: Document;

function reset() {
	delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY];
	delete (globalThis as unknown as Record<symbol, unknown>)[STARTED_KEY];
}

beforeEach(() => {
	window = new Window({ url: "https://outlook.live.com/mail/0/" });
	doc = window.document as unknown as Document;
	reset();
});

afterEach(async () => {
	reset();
	await window.happyDOM.close();
});

const fakeTool = (name: string): WebMcpTool => ({ name, description: name, execute: () => "{}" });
const tools = Object.keys(WEBMCP_TOOL_CLASSES).map(fakeTool);
const names = async () => (await installModelContextShim(doc).getTools()).map((tool) => tool.name);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("registerOutlookTools", () => {
	it("registers the ten tools when the page lists no tool", async () => {
		expect(await registerOutlookTools(doc, tools)).toBe(10);
		expect((await names()).sort()).toEqual(Object.keys(WEBMCP_TOOL_CLASSES).sort());
	});

	it("registers nothing when the page has its own tool", async () => {
		installModelContextShim(doc).registerTool(fakeTool("search_mail"));
		expect(await registerOutlookTools(doc, tools)).toBe(0);
		expect(await names()).toEqual(["search_mail"]);
	});

	it("skips a dg_ tool that is already registered", async () => {
		installModelContextShim(doc).registerTool(fakeTool("dg_outlook_list"));
		expect(await registerOutlookTools(doc, tools)).toBe(9);
	});
});

describe("startOutlookPlugin", () => {
	it("registers the tools after load and calls OWA with the headers the page sent", async () => {
		const pageFetch = mock(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(OK));
		const host = window as unknown as Parameters<typeof startOutlookPlugin>[0];
		Object.defineProperty(host, "fetch", { configurable: true, writable: true, value: pageFetch });
		startOutlookPlugin(host);
		await settle();
		expect(await names()).toHaveLength(10);

		await host.fetch("/owa/0/service.svc?action=FindItem&app=Mail", {
			headers: { "x-owa-canary": "fixture-canary", "x-anchormailbox": "PUID:fixture@example.com" },
		});
		const context = installModelContextShim(doc);
		const output = await context.executeTool({ name: "dg_outlook_delete", description: "" }, '{"ids":["AAMkFixtureItem1="]}');
		expect(JSON.parse(output)).toEqual({ deleted: 1, ids: ["AAMkFixtureItem1="] });
		const [url, init] = pageFetch.mock.calls.at(-1) as [string, RequestInit];
		expect(url).toBe("https://outlook.live.com/owa/0/service.svc?action=DeleteItem&app=Mail");
		expect(init.headers).toEqual(expect.objectContaining({ "x-owa-canary": "fixture-canary" }));
	});

	it("starts once per page, so a second start taps the page fetch and XHR no second time", async () => {
		const host = window as unknown as Parameters<typeof startOutlookPlugin>[0];
		Object.defineProperty(host, "fetch", { configurable: true, writable: true, value: mock(async () => Response.json(OK)) });
		startOutlookPlugin(host);
		const tapped = host.fetch;
		const xhrSend = host.XMLHttpRequest.prototype.send;
		startOutlookPlugin(host);
		expect(host.fetch).toBe(tapped);
		expect(host.XMLHttpRequest.prototype.send).toBe(xhrSend);
		await settle();
		expect(await names()).toHaveLength(10);
	});
});
