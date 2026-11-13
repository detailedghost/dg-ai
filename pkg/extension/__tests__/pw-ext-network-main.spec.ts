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
		const names = ["authorization", "cookie", "x-owa-canary", "x-csrf-token", "x-api-key", "x-owa-sessionid", "ocp-apim-subscription-key", "dpop", "action", "accept", "x-req-source", "content-type"];
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

	it("reports an unknown size when a response has no content-length", async () => {
		pwExtNetwork({ kind: "install" });
		reply = async () => new window.Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }) as unknown as Response;
		await page().fetch("https://mail.example.test/img");
		await settle();
		expect(read()[0]?.response).toEqual({ type: "image/png", size: -1 });
	});

	it("leaves a one-shot header iterable to the page", async () => {
		pwExtNetwork({ kind: "install" });
		function* once() {
			yield ["x-one", "1"] as [string, string];
		}
		const headers = once();
		await page().fetch("https://mail.example.test/gen", { headers: headers as unknown as HeadersInit });
		await settle();
		expect([...(calls.at(-1)?.init?.headers as Iterable<unknown>)]).toEqual([["x-one", "1"]]);
		expect(read()[0]?.requestHeaders).toEqual([]);
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
		xhr.setRequestHeader("Accept", "application/json");
		xhr.setRequestHeader("Accept", "text/plain");
		xhr.send('{"Name":"x"}');
		await settle();
		const [entry] = read();
		expect(entry).toMatchObject({
			via: "xhr",
			method: "PUT",
			status: 201,
			requestHeaders: [{ name: "authorization" }, { name: "accept" }],
			responseHeaders: [{ name: "content-type" }, { name: "cookie2" }],
			request: { shape: { keys: [["Name", "string"]] } },
			response: { shape: { keys: [["Ok", "boolean"], ["List", { n: 0 }]] } },
		});
		expect(xhr.sent).toEqual(['{"Name":"x"}']);
		expect(read(true)[0]?.requestHeaders).toContainEqual({ name: "accept", value: "application/json, text/plain" });
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

describe("sealed sign-in headers, agent fetch and storage", () => {
	const MARKER = "fake-marker-value-for-tests";
	const globalsText = () => {
		const win = window as unknown as Record<string | symbol, unknown>;
		const parts: string[] = [];
		for (const key of [...Object.getOwnPropertyNames(win), ...Object.getOwnPropertySymbols(win)]) {
			try {
				parts.push(JSON.stringify((win as Record<string | symbol, unknown>)[key as string]) ?? "");
			} catch {}
		}
		return parts.join("\n");
	};
	const sealedGet = (name: string) => pwExtNetwork({ kind: "sealed-get", name });
	const signIn = (url = "/owa/service.svc?action=GetItem", anchor = "PUID:1@fake") =>
		page().fetch(url, { headers: { Authorization: `Bearer ${MARKER}`, "X-AnchorMailbox": anchor } });

	it("keeps no sign-in header before the approval", async () => {
		pwExtNetwork({ kind: "install" });
		await signIn();
		await settle();
		expect(sealedGet("authorization")).toEqual({ missing: true });
	});

	it("keeps same-origin sign-in headers after the approval, never in reads or page globals", async () => {
		pwExtNetwork({ kind: "install", seal: true });
		await signIn();
		await settle();
		expect(sealedGet("authorization")).toEqual({ value: `Bearer ${MARKER}` });
		expect(JSON.stringify(read(true))).not.toContain(MARKER);
		expect(JSON.stringify(slotEntries())).not.toContain(MARKER);
		expect(globalsText()).not.toContain(MARKER);
	});

	it("ignores cross-origin requests and drops the values when the account anchor changes", async () => {
		pwExtNetwork({ kind: "install" });
		pwExtNetwork({ kind: "seal" });
		await signIn("https://other.example.test/x");
		await settle();
		expect(sealedGet("authorization")).toEqual({ missing: true });
		await signIn();
		await page().fetch("/x", { headers: { "X-AnchorMailbox": "PUID:2@fake" } });
		await settle();
		expect(sealedGet("authorization")).toEqual({ missing: true });
	});

	it("forgets sealed values on remove and on a new owner", async () => {
		pwExtNetwork({ kind: "install", seal: true }, undefined, 1);
		await signIn();
		await settle();
		pwExtNetwork({ kind: "read", values: false }, undefined, 2);
		expect(sealedGet("authorization")).toEqual({ missing: true });
	});

	it("attaches sealed headers to the agent's own fetch and returns no sign-in value", async () => {
		pwExtNetwork({ kind: "install", seal: true });
		await signIn();
		await settle();
		const result = (await pwExtNetwork({
			kind: "fetch",
			url: "https://mail.example.test/owa/service.svc?action=FindItem",
			method: "POST",
			body: '{"A":1}',
			contentType: "application/json",
			headers: [],
			auth: true,
			values: true,
		})) as { entries: NetworkEntry[] };
		const sent = calls.at(-1)?.init?.headers as Headers;
		expect(sent.get("authorization")).toBe(`Bearer ${MARKER}`);
		expect(calls.at(-1)?.init?.credentials).toBe("same-origin");
		expect(result.entries[0]).toMatchObject({ method: "POST", status: 200 });
		expect(result.entries[0]?.requestHeaders).toContainEqual({ name: "authorization" });
		expect(JSON.stringify(result)).not.toContain(MARKER);
	});

	it("removes sealed values from an echoed response and from network reads", async () => {
		pwExtNetwork({ kind: "install", seal: true });
		await signIn();
		await settle();
		reply = async () =>
			new window.Response(JSON.stringify({ echo: `Bearer ${MARKER}`, raw: MARKER }), {
				headers: { "content-type": "application/json", "x-echo": MARKER },
			}) as unknown as Response;
		const result = await pwExtNetwork({ kind: "fetch", url: "/echo", method: "GET", headers: [], auth: true, values: true });
		await settle();
		expect(JSON.stringify(result)).not.toContain(MARKER);
		expect(JSON.stringify(read(true))).not.toContain(MARKER);
	});

	it("removes encoded forms and a token that rotated while the fetch was pending", async () => {
		const token = "fake/marker+value=for-tests";
		pwExtNetwork({ kind: "install", seal: true });
		await page().fetch("/a", { headers: { Authorization: `Bearer ${token}` } });
		await settle();
		let rotated = false;
		reply = async () => {
			if (!rotated) {
				rotated = true;
				await page().fetch("/b", { headers: { Authorization: "Bearer fake-rotated-value-for-tests" } });
			}
			return new window.Response(JSON.stringify({ a: encodeURIComponent(token), b: token }), {
				headers: { "content-type": "application/json" },
			}) as unknown as Response;
		};
		const result = (await pwExtNetwork({ kind: "fetch", url: "/echo", method: "GET", headers: [], auth: true, values: true })) as {
			entries: NetworkEntry[];
		};
		expect(result.entries[0]?.status).toBe(200);
		expect(result.entries[0]?.response?.text).toContain("[redacted]");
		const text = JSON.stringify(result);
		expect(text).not.toContain("marker+value");
		expect(text).not.toContain(encodeURIComponent(token));
	});

	it("drops sealed values when an XHR changes the account anchor", async () => {
		pwExtNetwork({ kind: "install", seal: true });
		await signIn();
		await settle();
		const xhr = new (page().XMLHttpRequest)();
		xhr.open("POST", "https://mail.example.test/owa/service.svc");
		xhr.setRequestHeader("X-AnchorMailbox", "PUID:9@fake");
		xhr.send("{}");
		await settle();
		expect(sealedGet("authorization")).toEqual({ missing: true });
	});

	it("refuses an agent fetch to another origin, and auth before any sign-in was seen", async () => {
		pwExtNetwork({ kind: "install", seal: true });
		const base = { method: "GET", headers: [] as [string, string][], values: false };
		expect(await pwExtNetwork({ kind: "fetch", url: "https://other.example.test/", auth: false, ...base })).toEqual({
			error: "pw --ext fetch sends requests only to the page's own origin.",
		});
		expect(await pwExtNetwork({ kind: "fetch", url: "/x", auth: true, ...base })).toMatchObject({
			error: expect.stringContaining("No sign-in header"),
		});
	});

	it("reads storage shapes, values only on request, and one raw value for a save", () => {
		window.localStorage.setItem("msal.account", JSON.stringify({ username: "ada", accessToken: MARKER }));
		window.sessionStorage.setItem("note", "hello");
		pwExtNetwork({ kind: "install" });
		const shape = pwExtNetwork({ kind: "storage", area: "local", values: false });
		expect(shape).toEqual({
			items: [{ key: "msal.account", length: expect.any(Number), type: "json", shape: { keys: [["username", "string"], ["accessToken", "string"]] } }],
			total: 1,
		});
		expect(JSON.stringify(shape)).not.toContain(MARKER);
		expect(pwExtNetwork({ kind: "storage", area: "session", values: true })).toMatchObject({ items: [{ key: "note", value: "hello" }] });
		expect(pwExtNetwork({ kind: "storage", area: "local", keysOnly: true, values: false })).toEqual({
			items: [{ key: "msal.account", length: expect.any(Number), type: "text" }],
			total: 1,
		});
		expect(pwExtNetwork({ kind: "storage-get", area: "local", key: "msal.account" })).toEqual({
			value: JSON.stringify({ username: "ada", accessToken: MARKER }),
		});
		expect(pwExtNetwork({ kind: "storage-get", area: "local", key: "none" })).toEqual({ missing: true });
	});
});

describe("sealed history", () => {
	it("scrubs a value from retained entries when it leaves the history", async () => {
		const first = "fake-first-token-value-for-tests";
		pwExtNetwork({ kind: "install", seal: true });
		reply = async () =>
			new window.Response(JSON.stringify({ echo: first }), { headers: { "content-type": "application/json" } }) as unknown as Response;
		await page().fetch("/a", { headers: { Authorization: `Bearer ${first}` } });
		await settle();
		reply = async () => new window.Response("{}", { headers: { "content-type": "application/json" } }) as unknown as Response;
		for (let i = 0; i < 70; i++) await page().fetch(`/r${i}`, { headers: { Authorization: `Bearer fake-rotated-value-${i}-for-tests` } });
		await settle();
		expect(JSON.stringify(read(true))).not.toContain(first);
	});

	it("keeps masking a rotated sign-in value in retained responses", async () => {
		const old = "fake-old-token-value-for-tests";
		pwExtNetwork({ kind: "install", seal: true });
		reply = async () =>
			new window.Response(JSON.stringify({ echo: old }), { headers: { "content-type": "application/json" } }) as unknown as Response;
		await page().fetch("/a", { headers: { Authorization: `Bearer ${old}` } });
		await settle();
		await page().fetch("/b", { headers: { Authorization: "Bearer fake-new-token-value-for-tests" } });
		await settle();
		expect(JSON.stringify(read(true))).not.toContain(old);
	});
});

describe("sealed values in storage and long bodies", () => {
	it("removes a sealed value from storage values", async () => {
		const token = "fake-csrf-value-for-tests";
		window.localStorage.setItem("data", JSON.stringify({ data: token }));
		pwExtNetwork({ kind: "install", seal: true });
		await page().fetch("/a", { headers: { "X-Csrf-Token": token } });
		await settle();
		expect(JSON.stringify(pwExtNetwork({ kind: "storage", area: "local", values: true }))).not.toContain(token);
	});

	it("keeps a masked body within the wire bound", async () => {
		const short = "fake8chr";
		pwExtNetwork({ kind: "install", seal: true });
		reply = async () =>
			new window.Response(`${"x".repeat(7992)}${short}`, { headers: { "content-type": "text/plain" } }) as unknown as Response;
		await page().fetch("/a", { headers: { Authorization: short } });
		await settle();
		const [entry] = read(true);
		expect(entry?.response?.text?.length).toBeLessThanOrEqual(8000);
		expect(entry?.response?.cut).toBe(true);
	});
});

describe("cut edges and delayed responses", () => {
	it("masks a sealed value cut at the body bound", async () => {
		const token = "fake-cut-edge-token-value-for-tests";
		pwExtNetwork({ kind: "install", seal: true });
		reply = async () =>
			new window.Response(`${"x".repeat(7990)}${token}`, { headers: { "content-type": "text/plain" } }) as unknown as Response;
		await page().fetch("/a", { headers: { Authorization: token } });
		await settle();
		const [entry] = read(true);
		expect(entry?.response?.text).not.toContain(token.slice(0, 10));
		expect(entry?.response?.text?.endsWith("[redacted]")).toBe(true);
	});

	it("masks a delayed response that echoes its own sign-in value after the history moved on", async () => {
		const first = "fake-delayed-token-value-for-tests";
		pwExtNetwork({ kind: "install", seal: true });
		const fast = async () => new window.Response("{}", { headers: { "content-type": "application/json" } }) as unknown as Response;
		let release: (() => void) | undefined;
		const slow = new Promise<Response>((resolve) => {
			release = () =>
				resolve(new window.Response(JSON.stringify({ echo: first }), { headers: { "content-type": "application/json" } }) as unknown as Response);
		});
		reply = () => slow;
		const pending = page().fetch("/slow", { headers: { Authorization: `Bearer ${first}` } });
		reply = fast;
		for (let i = 0; i < 70; i++) await page().fetch(`/r${i}`, { headers: { Authorization: `Bearer fake-rotated-value-${i}-for-tests` } });
		release?.();
		await pending;
		await settle();
		const text = JSON.stringify(read(true));
		expect(text).toContain("[redacted]");
		expect(text).not.toContain(first);
	});
});
