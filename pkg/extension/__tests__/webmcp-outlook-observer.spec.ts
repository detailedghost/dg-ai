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
		expect(observer.getHeaders()).toEqual({
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
		expect(observer.getHeaders()?.["x-owa-canary"]).toBe(ACCOUNT_A["x-owa-canary"]);
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
		expect(observer.getHeaders()).toBeUndefined();
		observer.dispose();
	});

	it("ignores every request when the page is not an Outlook host", async () => {
		const page = host("https://outlook.com/owa/");
		const observer = installOutlookHeaderObserver(page as never);
		await page.fetch("/owa/service.svc", { headers: ACCOUNT_A });
		expect(observer.getHeaders()).toBeUndefined();
		observer.dispose();
	});

	it("ignores a request with neither a token nor a canary", async () => {
		const page = host();
		const observer = installOutlookHeaderObserver(page as never);
		await page.fetch(SERVICE, { headers: { "x-anchormailbox": "PUID:fixture-a@example.com" } });
		expect(observer.getHeaders()).toBeUndefined();
		observer.dispose();
	});

	it("drops the whole copy when X-AnchorMailbox changes", async () => {
		const page = host();
		const observer = installOutlookHeaderObserver(page as never);
		await page.fetch(SERVICE, { headers: ACCOUNT_A });
		await page.fetch(SERVICE, { headers: ACCOUNT_B });
		const held = JSON.stringify(observer.getHeaders());
		expect(held).not.toContain("fixture-a");
		expect(held).not.toContain("fixture-session-a");
		expect(observer.getHeaders()).toEqual(ACCOUNT_B);
		observer.dispose();
	});

	it("merges a refreshed token into the copy of the same account", async () => {
		const page = host();
		const observer = installOutlookHeaderObserver(page as never);
		await page.fetch(SERVICE, { headers: ACCOUNT_A });
		await page.fetch(SERVICE, {
			headers: { authorization: "Bearer fixture-token-a2", "x-anchormailbox": ACCOUNT_A["x-anchormailbox"] },
		});
		expect(observer.getHeaders()).toEqual(expect.objectContaining({
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
		expect(observer.getHeaders()).toEqual({ "x-owa-canary": "fixture-canary-a" });
		observer.dispose();
	});

	it("keeps the session headers of a same-origin service.svc XHR", () => {
		const page = host();
		const observer = installOutlookHeaderObserver(page as never);
		const xhr = new page.XMLHttpRequest();
		xhr.open("POST", SERVICE);
		for (const [name, value] of Object.entries(ACCOUNT_A)) xhr.setRequestHeader(name, value);
		xhr.send();
		expect(observer.getHeaders()?.authorization).toBe(ACCOUNT_A.authorization);
		observer.dispose();
	});

	it("returns a copy, so a caller cannot change the held headers", async () => {
		const page = host();
		const observer = installOutlookHeaderObserver(page as never);
		await page.fetch(SERVICE, { headers: ACCOUNT_A });
		const first = observer.getHeaders() as Record<string, string>;
		first.authorization = "changed";
		expect(observer.getHeaders()?.authorization).toBe(ACCOUNT_A.authorization);
		observer.dispose();
		expect(observer.getHeaders()).toBeUndefined();
	});
});
