import { describe, expect, it, mock } from "bun:test";
import { installOutlookHeaderObserver } from "@/lib/features/webmcp-outlook/observer";

class FakeXhr extends EventTarget {
	open(_method: string, _url: string) {}
	setRequestHeader(_name: string, _value: string) {}
	send(_body?: unknown) {}
}

function host(href = "https://outlook.live.com/mail/0/") {
	return {
		location: new URL(href),
		fetch: mock(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response("{}")),
		XMLHttpRequest: class extends FakeXhr {},
	};
}

const SERVICE = "https://outlook.live.com/owa/0/service.svc?action=FindItem&app=Mail";
const PATH = "/owa/0/service.svc";
const ACCOUNT_A = {
	authorization: "Bearer fixture-token-a",
	"x-owa-canary": "fixture-canary-a",
	"x-anchormailbox": "PUID:fixture-a@example.com",
	"x-owa-sessionid": "fixture-session-a",
	action: "FindItem",
	cookie: "fixture-cookie",
};
const ACCOUNT_B = {
	authorization: "Bearer fixture-token-b",
	"x-owa-canary": "fixture-canary-b",
	"x-anchormailbox": "PUID:fixture-b@example.com",
};

describe("installOutlookHeaderObserver", () => {
	it("keeps only the session headers of a same-origin service.svc fetch and leaves the request unchanged", async () => {
		const page = host();
		const original = page.fetch;
		const observer = installOutlookHeaderObserver(page as never);
		const init = { method: "POST", headers: ACCOUNT_A };
		await page.fetch(SERVICE, init);
		expect(original).toHaveBeenCalledWith(SERVICE, init);
		expect(observer.getHeaders(PATH)).toEqual({
			authorization: ACCOUNT_A.authorization,
			"x-owa-canary": ACCOUNT_A["x-owa-canary"],
			"x-anchormailbox": ACCOUNT_A["x-anchormailbox"],
			"x-owa-sessionid": ACCOUNT_A["x-owa-sessionid"],
		});
		observer.dispose();
		expect(page.fetch).toBe(original);
	});

	it.each([
		["the business service path", "https://outlook.cloud.microsoft/mail/", "https://outlook.cloud.microsoft/owa/service.svc?action=GetItem"],
		["a relative service path", "https://outlook.office.com/mail/", "/owa/service.svc?action=FindItem"],
	])("keeps headers from %s", async (_label, href, url) => {
		const page = host(href);
		const observer = installOutlookHeaderObserver(page as never);
		await page.fetch(url, { headers: ACCOUNT_A });
		expect(observer.getHeaders("/owa/service.svc")?.["x-owa-canary"]).toBe(ACCOUNT_A["x-owa-canary"]);
		observer.dispose();
	});

	it.each([
		"https://login.microsoftonline.com/owa/service.svc",
		"https://outlook.live.com.evil.example/owa/0/service.svc",
		"https://outlook.live.com/owa/0/startupdata.ashx",
		"https://outlook.live.com/api/service.svc/x",
		"http://outlook.live.com/owa/0/service.svc",
	])("ignores headers sent to %s", async (url) => {
		const page = host();
		const observer = installOutlookHeaderObserver(page as never);
		await page.fetch(url, { headers: ACCOUNT_A });
		expect(observer.getHeaders(PATH)).toBeUndefined();
		observer.dispose();
	});

	it("keeps the headers of each account endpoint apart and gives one endpoint only its own copy", async () => {
		const page = host();
		const observer = installOutlookHeaderObserver(page as never);
		await page.fetch(SERVICE, { headers: ACCOUNT_A });
		await page.fetch("https://outlook.live.com/owa/1/service.svc?action=FindItem&app=Mail", { headers: ACCOUNT_B });
		expect(observer.getHeaders(PATH)?.authorization).toBe(ACCOUNT_A.authorization);
		expect(observer.getHeaders("/owa/1/service.svc")).toEqual(ACCOUNT_B);
		expect(JSON.stringify(observer.getHeaders(PATH))).not.toContain("fixture-b");
		expect(observer.getHeaders("/owa/2/service.svc")).toBeUndefined();
		expect(observer.getHeaders("/owa/service.svc")).toBeUndefined();
		observer.dispose();
	});

	it("drops only the copy of the endpoint whose anchor changed", async () => {
		const page = host();
		const observer = installOutlookHeaderObserver(page as never);
		await page.fetch(SERVICE, { headers: ACCOUNT_A });
		await page.fetch("/owa/1/service.svc", { headers: ACCOUNT_B });
		await page.fetch("/owa/1/service.svc", { headers: { "x-anchormailbox": "PUID:fixture-c@example.com" } });
		expect(observer.getHeaders("/owa/1/service.svc")).toBeUndefined();
		expect(observer.getHeaders(PATH)?.authorization).toBe(ACCOUNT_A.authorization);
		observer.dispose();
	});

	it("ignores every request when the page is not an Outlook host", async () => {
		const page = host("https://outlook.com/owa/");
		const observer = installOutlookHeaderObserver(page as never);
		await page.fetch("/owa/service.svc", { headers: ACCOUNT_A });
		expect(observer.getHeaders("/owa/service.svc")).toBeUndefined();
		observer.dispose();
	});

	it("ignores a request with neither a token nor a canary", async () => {
		const page = host();
		const observer = installOutlookHeaderObserver(page as never);
		await page.fetch(SERVICE, { headers: { "x-anchormailbox": "PUID:fixture-a@example.com" } });
		expect(observer.getHeaders(PATH)).toBeUndefined();
		observer.dispose();
	});

	it("drops the whole copy when X-AnchorMailbox changes", async () => {
		const page = host();
		const observer = installOutlookHeaderObserver(page as never);
		await page.fetch(SERVICE, { headers: ACCOUNT_A });
		await page.fetch(SERVICE, { headers: ACCOUNT_B });
		const held = JSON.stringify(observer.getHeaders(PATH));
		expect(held).not.toContain("fixture-a");
		expect(held).not.toContain("fixture-session-a");
		expect(observer.getHeaders(PATH)).toEqual(ACCOUNT_B);
		observer.dispose();
	});

	it("drops the copy when X-AnchorMailbox changes on a request with no token or canary", async () => {
		const page = host();
		const observer = installOutlookHeaderObserver(page as never);
		await page.fetch(SERVICE, { headers: ACCOUNT_A });
		await page.fetch(SERVICE, { headers: { "x-anchormailbox": ACCOUNT_B["x-anchormailbox"] } });
		expect(observer.getHeaders(PATH)).toBeUndefined();
		observer.dispose();
	});

	it("keeps the copy on a request with no token, canary or anchor", async () => {
		const page = host();
		const observer = installOutlookHeaderObserver(page as never);
		await page.fetch(SERVICE, { headers: ACCOUNT_A });
		await page.fetch(SERVICE, { headers: { "x-owa-sessionid": "fixture-session-a" } });
		expect(observer.getHeaders(PATH)?.authorization).toBe(ACCOUNT_A.authorization);
		observer.dispose();
	});

	it("merges a refreshed token into the copy of the same account", async () => {
		const page = host();
		const observer = installOutlookHeaderObserver(page as never);
		await page.fetch(SERVICE, { headers: ACCOUNT_A });
		await page.fetch(SERVICE, {
			headers: { authorization: "Bearer fixture-token-a2", "x-anchormailbox": ACCOUNT_A["x-anchormailbox"] },
		});
		expect(observer.getHeaders(PATH)).toEqual(expect.objectContaining({
			authorization: "Bearer fixture-token-a2",
			"x-owa-canary": ACCOUNT_A["x-owa-canary"],
		}));
		observer.dispose();
	});

	it("skips a header value with a line break or one longer than 8192 characters", async () => {
		const page = host();
		const observer = installOutlookHeaderObserver(page as never);
		const xhr = new page.XMLHttpRequest();
		xhr.open("POST", SERVICE);
		xhr.setRequestHeader("x-owa-canary", "fixture-canary-a");
		xhr.setRequestHeader("authorization", `Bearer ${"t".repeat(9000)}`);
		xhr.send();
		expect(observer.getHeaders(PATH)).toEqual({ "x-owa-canary": "fixture-canary-a" });
		observer.dispose();
	});

	it("keeps the session headers of a same-origin service.svc XHR", () => {
		const page = host();
		const observer = installOutlookHeaderObserver(page as never);
		const xhr = new page.XMLHttpRequest();
		xhr.open("POST", SERVICE);
		for (const [name, value] of Object.entries(ACCOUNT_A)) xhr.setRequestHeader(name, value);
		xhr.send();
		expect(observer.getHeaders(PATH)?.authorization).toBe(ACCOUNT_A.authorization);
		observer.dispose();
	});

	it("returns a copy, so a caller cannot change the held headers", async () => {
		const page = host();
		const observer = installOutlookHeaderObserver(page as never);
		await page.fetch(SERVICE, { headers: ACCOUNT_A });
		const first = observer.getHeaders(PATH) as Record<string, string>;
		first.authorization = "changed";
		expect(observer.getHeaders(PATH)?.authorization).toBe(ACCOUNT_A.authorization);
		observer.dispose();
		expect(observer.getHeaders(PATH)).toBeUndefined();
	});
});
