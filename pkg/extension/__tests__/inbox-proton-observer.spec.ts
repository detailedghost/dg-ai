import { expect, it, mock } from "bun:test";
import { installProtonSessionObserver } from "../lib/features/inbox-proton-observer";

class FakeXhr extends EventTarget {
	open(_method: string, _url: string) {}
	setRequestHeader(_name: string, _value: string) {}
	send(_body?: unknown) {}
}

function host() {
	return {
		location: new URL("https://mail.proton.me/u/0/inbox"),
		fetch: mock(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response("{}")),
		XMLHttpRequest: class extends FakeXhr {},
	};
}

const sessionHeaders = {
	"x-pm-uid": "session-private-uid",
	"x-pm-appversion": "web-mail@5.0.0",
	"x-pm-locale": "en_US",
};

it("observes authenticated fetch headers without changing the page request or response", async () => {
	const page = host();
	const original = page.fetch;
	const observer = installProtonSessionObserver(page as never);
	const input = { credentials: "include" as const, headers: sessionHeaders };
	const response = await page.fetch("https://mail.proton.me/api/mail/v4/messages", input);
	expect(response).toBeInstanceOf(Response);
	expect(original).toHaveBeenCalledWith("https://mail.proton.me/api/mail/v4/messages", input);
	expect(observer.getHeaders()).toEqual({ uid: sessionHeaders["x-pm-uid"], appVersion: sessionHeaders["x-pm-appversion"], locale: sessionHeaders["x-pm-locale"] });
	observer.dispose();
	expect(page.fetch).toBe(original);
});

it("observes headers carried by a Request object and uses explicit init overrides", async () => {
	const page = host();
	const observer = installProtonSessionObserver(page as never);
	await page.fetch(new Request("https://mail.proton.me/api/mail/v4/messages", { headers: sessionHeaders }));
	expect(observer.getHeaders()?.uid).toBe(sessionHeaders["x-pm-uid"]);
	await page.fetch(new Request("https://mail.proton.me/api/mail/v4/messages", { headers: sessionHeaders }), { headers: { ...sessionHeaders, "x-pm-uid": "new-account-uid" } });
	expect(observer.getHeaders()?.uid).toBe("new-account-uid");
	observer.dispose();
});

it.each([
	"https://account.proton.me/api/auth/v4/sessions",
	"https://mail.proton.me.attacker.test/api/mail/v4/messages",
	"https://mail.proton.me/not-api",
])("ignores authenticated-looking headers from other origins or non-API URLs %s", async (url) => {
	const page = host();
	const observer = installProtonSessionObserver(page as never);
	await page.fetch(url, { headers: sessionHeaders });
	expect(observer.getHeaders()).toBeUndefined();
	observer.dispose();
});

it("captures only the allowed session fields and does not retain Authorization or cookies", async () => {
	const page = host();
	const observer = installProtonSessionObserver(page as never);
	await page.fetch("/api/mail/v4/messages", { headers: { ...sessionHeaders, authorization: "Bearer private-token", cookie: "session=private-cookie" } });
	const captured = JSON.stringify(observer.getHeaders());
	expect(captured).not.toContain("private-token");
	expect(captured).not.toContain("private-cookie");
	observer.dispose();
});

it("observes authenticated XHR headers and leaves the native methods usable", () => {
	const page = host();
	const observer = installProtonSessionObserver(page as never);
	const xhr = new page.XMLHttpRequest();
	xhr.open("GET", "/api/mail/v4/messages");
	for (const [name, value] of Object.entries(sessionHeaders)) xhr.setRequestHeader(name, value);
	xhr.send();
	expect(observer.getHeaders()?.uid).toBe(sessionHeaders["x-pm-uid"]);
	expect(observer.getHeaders()?.appVersion).toBe(sessionHeaders["x-pm-appversion"]);
	observer.dispose();
});

it("ignores XHR session headers from account.proton.me", () => {
	const page = host();
	const observer = installProtonSessionObserver(page as never);
	const xhr = new page.XMLHttpRequest();
	xhr.open("GET", "https://account.proton.me/api/auth/v4/sessions");
	xhr.setRequestHeader("x-pm-uid", "wrong-account-uid");
	xhr.send();
	expect(observer.getHeaders()).toBeUndefined();
	observer.dispose();
});

it("invalidates observed credentials on an account switch until the new account makes its own authenticated request", async () => {
	const page = host();
	const observer = installProtonSessionObserver(page as never);
	await page.fetch("/api/mail/v4/messages", { headers: sessionHeaders });
	expect(observer.getHeaders()?.uid).toBe(sessionHeaders["x-pm-uid"]);
	page.location.pathname = "/u/1/inbox";
	expect(observer.getHeaders()).toBeUndefined();
	await page.fetch("/api/mail/v4/messages", { headers: { ...sessionHeaders, "x-pm-uid": "second-account-uid" } });
	expect(observer.getHeaders()?.uid).toBe("second-account-uid");
	page.location.pathname = "/u/0/inbox";
	expect(observer.getHeaders()).toBeUndefined();
	observer.dispose();
	expect(observer.getHeaders()).toBeUndefined();
});

it("returns copies of observed headers so callers cannot replace the page's account identity", async () => {
	const page = host();
	const observer = installProtonSessionObserver(page as never);
	await page.fetch("/api/mail/v4/messages", { headers: sessionHeaders });
	const snapshot = observer.getHeaders()!;
	snapshot.uid = "caller-mutated-uid";
	expect(observer.getHeaders()?.uid).toBe(sessionHeaders["x-pm-uid"]);
	observer.dispose();
});
