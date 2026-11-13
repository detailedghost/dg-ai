import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { isSensitiveHeader, type NetworkEntry, validateNetworkEntries } from "@dg/common";
import { Window } from "happy-dom";
import { pwExtNetwork } from "@/lib/features/pw-ext-network-main";

const TOKEN = "fake-token-value-for-tests";
const CANARY = "fake-canary-value-for-tests";
const ITEM = "fake-item-marker";

let window: Window;
let calls: { input: unknown; init?: RequestInit }[];
let reply: () => Promise<Response>;
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");

type Page = { fetch: typeof fetch; XMLHttpRequest: typeof FakeXhr };

class FakeXhr {
	static next = { status: 200, headers: "content-type: application/json\r\nx-fake-id: abc\r\n", body: "{}" };
	status = 0;
	responseType = "";
	responseText = "";
	response: unknown = "";
	private listeners: (() => void)[] = [];
	sent: unknown[] = [];
	open(_method: string, _url: string) {}
	setRequestHeader(_name: string, _value: string) {}
	send(body?: unknown) {
		this.sent.push(body);
		queueMicrotask(() => {
			this.status = FakeXhr.next.status;
			this.responseText = FakeXhr.next.body;
			this.response = FakeXhr.next.body;
			for (const listener of this.listeners) listener();
		});
	}
	getAllResponseHeaders() {
		return FakeXhr.next.headers;
	}
	addEventListener(type: string, listener: () => void) {
		if (type === "loadend") this.listeners.push(listener);
	}
}

const page = () => window as unknown as Page;
const slotEntries = () =>
	(window as unknown as Record<symbol, { entries: NetworkEntry[] }>)[Symbol.for("dg.pwExt.network")]?.entries ?? [];
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

function read(values = false, since?: number): NetworkEntry[] {
	const result = pwExtNetwork({ kind: "read", values, ...(since === undefined ? {} : { since }) });
	if (!("entries" in result)) throw new Error(JSON.stringify(result));
	return validateNetworkEntries(result);
}

beforeEach(() => {
	window = new Window({ url: "https://mail.example.test/mail/0/inbox" });
	Object.defineProperty(globalThis, "document", { configurable: true, value: window.document });
	calls = [];
	reply = async () =>
		new window.Response(JSON.stringify({ Body: { Items: [{ Id: ITEM, Size: 3 }, { Id: ITEM, Size: 4 }] } }), {
			status: 200,
			headers: { "content-type": "application/json; charset=utf-8", "set-cookie": `s=${TOKEN}` },
		}) as unknown as Response;
	page().fetch = (async (input: unknown, init?: RequestInit) => {
		calls.push({ input, ...(init ? { init } : {}) });
		return reply();
	}) as typeof fetch;
	page().XMLHttpRequest = FakeXhr;
});

afterEach(async () => {
	if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
	else delete (globalThis as { document?: unknown }).document;
	await window.happyDOM.close();
});

async function owaCall() {
	const response = await page().fetch("/owa/0/service.svc?action=FindConversation&app=Mail", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${TOKEN}`,
			"X-OWA-CANARY": CANARY,
			Action: "FindConversation",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ __type: "FindConversationJsonRequest:#Exchange", Body: { ParentFolderId: ITEM } }),
	});
	await settle();
	return response;
}

describe("network hook", () => {
	it("records the shape of a fetch and never stores a sensitive header value", async () => {
		pwExtNetwork({ kind: "install" });
		const response = await owaCall();
		expect(await response.json()).toEqual({ Body: { Items: [{ Id: ITEM, Size: 3 }, { Id: ITEM, Size: 4 }] } });
		const [entry] = read();
		expect(entry).toMatchObject({
			via: "fetch",
			method: "POST",
			url: "https://mail.example.test/owa/0/service.svc?action=FindConversation&app=Mail",
			status: 200,
			requestHeaders: [{ name: "authorization" }, { name: "x-owa-canary" }, { name: "action" }, { name: "content-type" }],
			request: {
				type: "application/json",
				shape: { keys: [["__type", "string"], ["Body", { keys: [["ParentFolderId", "string"]] }]] },
			},
			response: {
				type: "application/json; charset=utf-8",
				shape: { keys: [["Body", { keys: [["Items", { n: 2, of: { keys: [["Id", "string"], ["Size", "number"]] } }]] }]] },
			},
		});
		const shapeOnly = JSON.stringify(read());
		for (const value of [TOKEN, CANARY, ITEM, "FindConversationJsonRequest"]) expect(shapeOnly).not.toContain(value);
		const stored = JSON.stringify(slotEntries());
		expect(stored).not.toContain(TOKEN);
		expect(stored).not.toContain(CANARY);
	});

	it("returns values only on a values read, and still no sensitive header value", async () => {
		pwExtNetwork({ kind: "install" });
		await owaCall();
		const [entry] = read(true);
		expect(entry?.requestHeaders).toContainEqual({ name: "action", value: "FindConversation" });
		expect(entry?.requestHeaders).toContainEqual({ name: "authorization" });
		expect(entry?.request?.text).toContain(ITEM);
		expect(entry?.response?.text).toContain(ITEM);
		expect(JSON.stringify(entry)).not.toContain(TOKEN);
		expect(JSON.stringify(entry)).not.toContain(CANARY);
	});

	it("withholds exactly the header values that the shared rule calls sensitive", async () => {
		const names = ["authorization", "cookie", "x-owa-canary", "x-csrf-token", "x-api-key", "x-owa-sessionid", "action", "accept", "x-req-source", "content-type"];
		pwExtNetwork({ kind: "install" });
		await page().fetch("https://mail.example.test/h", { headers: Object.fromEntries(names.map((name) => [name, "fake-value"])) });
		await settle();
		const [entry] = read(true);
		for (const name of names)
			expect(entry?.requestHeaders.find((header) => header.name === name)?.value).toBe(isSensitiveHeader(name) ? undefined : "fake-value");
	});

	it("records the init headers, not the Request headers they replace", async () => {
		pwExtNetwork({ kind: "install" });
		const request = new window.Request("https://mail.example.test/r", { method: "POST", headers: { "x-old": "1" }, body: '{"A":1}' });
		await page().fetch(request as unknown as Request, { headers: { "content-type": "application/json" } });
		await settle();
		const [entry] = read();
		expect(entry?.requestHeaders).toEqual([{ name: "content-type" }]);
	});

	it("reads a Request body only up to the bound", async () => {
		pwExtNetwork({ kind: "install" });
		const big = `{"A":"${"x".repeat(1_100_000)}"}`;
		const request = new window.Request("https://mail.example.test/up", { method: "POST", headers: { "content-type": "application/json" }, body: big });
		await page().fetch(request as unknown as Request);
		await settle();
		const [entry] = read(true);
		expect(entry?.request).toMatchObject({ type: "application/json", size: -1, cut: true });
		expect(entry?.request?.shape).toBeUndefined();
		expect(entry?.request?.text?.length).toBe(8000);
	});

	it("records an XMLHttpRequest", async () => {
		pwExtNetwork({ kind: "install" });
		FakeXhr.next = { status: 201, headers: "Content-Type: application/json\r\nCookie2: x\r\n", body: '{"Ok":true,"List":[]}' };
		const xhr = new (page().XMLHttpRequest)();
		xhr.open("put", "https://mail.example.test/api/items/AAMkADU3ZmFrZWZha2VmYWtlZmFrZQ?x=1");
		xhr.setRequestHeader("Authorization", `Bearer ${TOKEN}`);
		xhr.send('{"Name":"x"}');
		await settle();
		const [entry] = read();
		expect(entry).toMatchObject({
			via: "xhr",
			method: "PUT",
			status: 201,
			requestHeaders: [{ name: "authorization" }],
			responseHeaders: [{ name: "content-type" }, { name: "cookie2" }],
			request: { shape: { keys: [["Name", "string"]] } },
			response: { shape: { keys: [["Ok", "boolean"], ["List", { n: 0 }]] } },
		});
		expect(xhr.sent).toEqual(['{"Name":"x"}']);
		expect(JSON.stringify(slotEntries())).not.toContain(TOKEN);
	});

	it("records a failed fetch and a non-JSON body as type and size only", async () => {
		pwExtNetwork({ kind: "install" });
		reply = async () => new window.Response("<p>hi</p>", { headers: { "content-type": "text/html" } }) as unknown as Response;
		await page().fetch("https://mail.example.test/page");
		reply = async () => {
			throw new TypeError("network down");
		};
		await expect(page().fetch("https://mail.example.test/down")).rejects.toThrow("network down");
		await settle();
		const [html, down] = read();
		expect(html?.response).toEqual({ type: "text/html", size: 9 });
		expect(down?.failed).toBe(true);
	});

	it("keeps a bounded ring of the newest requests", async () => {
		pwExtNetwork({ kind: "install" });
		for (let i = 0; i < 130; i++) await page().fetch(`https://mail.example.test/n/${i}`);
		await settle();
		const entries = read();
		expect(entries).toHaveLength(100);
		expect(entries.at(-1)?.url).toBe("https://mail.example.test/n/129");
	});

	it("filters by start time and clears on request", async () => {
		pwExtNetwork({ kind: "install" });
		await page().fetch("https://mail.example.test/a");
		const cut = Date.now();
		await new Promise((resolve) => setTimeout(resolve, 3));
		await page().fetch("https://mail.example.test/b");
		await settle();
		expect(read(false, cut).map((entry) => entry.url)).toEqual(["https://mail.example.test/b"]);
		expect(pwExtNetwork({ kind: "clear" })).toEqual({ cleared: 2 });
		expect(read()).toEqual([]);
	});

	it("starts empty when the tab moves to another agent group", async () => {
		pwExtNetwork({ kind: "install" }, undefined, 1);
		await page().fetch("https://mail.example.test/a");
		await settle();
		expect(pwExtNetwork({ kind: "read", values: false }, undefined, 2)).toEqual({ entries: [] });
	});

	it("gives the page its own fetch back on remove, and removal is final", async () => {
		const own = page().fetch;
		pwExtNetwork({ kind: "install" });
		expect(page().fetch).not.toBe(own);
		await page().fetch("https://mail.example.test/a");
		pwExtNetwork({ kind: "remove" });
		expect(page().fetch).toBe(own);
		expect(slotEntries()).toEqual([]);
		expect(pwExtNetwork({ kind: "install" })).toEqual({ entries: [] });
		expect(page().fetch).toBe(own);
		expect(pwExtNetwork({ kind: "read", values: false })).toMatchObject({ error: expect.stringContaining("lost its network capture") });
	});

	it("passes a call straight through when not active and refuses a changed page", () => {
		expect(pwExtNetwork({ kind: "read", values: false })).toEqual({ entries: [] });
		expect(pwExtNetwork({ kind: "install" }, "https://other.example.test/")).toEqual({
			error: "The page changed; nothing was done. Retry.",
		});
	});
});
