import { describe, expect, it } from "bun:test";
import {
	createOwaService,
	OUTLOOK_ACCOUNT_CHANGED,
	OUTLOOK_CANCELED,
	OUTLOOK_STILL_LOADING,
	servicePathOf,
} from "@/lib/features/webmcp-outlook/service";

const HEADERS = {
	authorization: "Bearer fixture-token",
	"x-owa-canary": "fixture-canary",
	"x-anchormailbox": "PUID:fixture@example.com",
};
const OK = { Body: { ResponseMessages: { Items: [{ ResponseClass: "Success", ResponseCode: "NoError" }] } } };

type Sent = { url: string; init: RequestInit };

function setup(
	options: {
		href?: string;
		location?: { origin: string; pathname: string };
		headers?: (path: string) => Record<string, string> | undefined;
		reply?: (sent: Sent) => Response | Promise<Response>;
	} = {},
) {
	const sent: Sent[] = [];
	const asked: string[] = [];
	const clock = { now: 0 };
	const headers = options.headers ?? (() => HEADERS);
	const service = createOwaService({
		location: options.location ?? new URL(options.href ?? "https://outlook.live.com/mail/0/"),
		headers: (path) => {
			asked.push(path);
			return headers(path);
		},
		fetch: async (input, init) => {
			const entry = { url: String(input), init: init ?? {} };
			sent.push(entry);
			return options.reply ? options.reply(entry) : Response.json(OK);
		},
		now: () => clock.now,
		sleep: async (ms) => {
			clock.now += ms;
		},
	});
	return { service, sent, clock, asked };
}

describe("createOwaService", () => {
	it.each([
		["https://outlook.live.com/mail/0/", "https://outlook.live.com/owa/0/service.svc?action=FindItem&app=Mail"],
		["https://outlook.live.com/mail/1/inbox", "https://outlook.live.com/owa/1/service.svc?action=FindItem&app=Mail"],
		["https://outlook.live.com/mail/", "https://outlook.live.com/owa/service.svc?action=FindItem&app=Mail"],
		["https://outlook.office.com/mail/", "https://outlook.office.com/owa/service.svc?action=FindItem&app=Mail"],
		["https://outlook.office.com/mail/2/", "https://outlook.office.com/owa/2/service.svc?action=FindItem&app=Mail"],
		["https://outlook.cloud.microsoft/mail/", "https://outlook.cloud.microsoft/owa/service.svc?action=FindItem&app=Mail"],
		["https://outlook.office365.com/mail/inbox", "https://outlook.office365.com/owa/service.svc?action=FindItem&app=Mail"],
	])("posts from %s to the endpoint of that account", async (href, url) => {
		const { service, sent, asked } = setup({ href });
		await service.call("FindItem", { Traversal: "Shallow" });
		expect(sent[0]?.url).toBe(url);
		expect([...new Set(asked)]).toEqual([new URL(url).pathname]);
	});

	it("sends no headers of another account endpoint and waits for its own", async () => {
		const { service, sent } = setup({
			href: "https://outlook.live.com/mail/1/",
			headers: (path) => (path === "/owa/0/service.svc" ? HEADERS : undefined),
		});
		await expect(service.call("FindItem", {})).rejects.toThrow(OUTLOOK_STILL_LOADING);
		expect(sent).toEqual([]);
	});

	it.each([
		[{ hostname: "outlook.live.com", pathname: "/mail/10/" }, "/owa/10/service.svc"],
		[{ hostname: "outlook.live.com", pathname: "/mail10/" }, "/owa/service.svc"],
		[{ hostname: "outlook.office.com", pathname: "/calendar/1/" }, "/owa/1/service.svc"],
		[{ hostname: "outlook.live.com", pathname: "/calendar/1/view/month" }, "/owa/1/service.svc"],
		[{ hostname: "outlook.live.com", pathname: "/people/2" }, "/owa/2/service.svc"],
		[{ hostname: "outlook.office.com", pathname: "/calendar/view/month" }, "/owa/service.svc"],
	])("maps %o to %s", (location, path) => {
		expect(servicePathOf(location)).toBe(path);
	});

	it("sends the captured headers, the action and the JSON request envelope", async () => {
		const { service, sent } = setup();
		await service.call("GetItem", { ItemIds: [] });
		const init = sent[0]?.init as RequestInit;
		expect(init.method).toBe("POST");
		expect(init.credentials).toBe("include");
		expect(init.headers).toEqual({
			...HEADERS,
			action: "GetItem",
			"content-type": "application/json; charset=utf-8",
			"x-req-source": "Mail",
		});
		expect(JSON.parse(init.body as string)).toEqual({
			__type: "GetItemJsonRequest:#Exchange",
			Header: { __type: "JsonRequestHeaders:#Exchange", RequestServerVersion: "Exchange2016" },
			Body: { ItemIds: [] },
		});
	});

	it("returns the response message items", async () => {
		const { service } = setup();
		expect(await service.call("UpdateItem", {})).toEqual(OK.Body.ResponseMessages.Items);
	});

	it.each([401, 440, 429])("maps the status %d to the refused message", async (status) => {
		const { service } = setup({ reply: () => new Response("nope", { status }) });
		await expect(service.call("FindItem", {})).rejects.toThrow(`Outlook refused the request (${status})`);
	});

	it("names any other failed status", async () => {
		const { service } = setup({ reply: () => new Response("nope", { status: 500 }) });
		await expect(service.call("FindItem", {})).rejects.toThrow("Outlook returned an error (500)");
	});

	it("returns every response message when only some of them failed", async () => {
		const items = [
			{ ResponseClass: "Success", ResponseCode: "NoError" },
			{ ResponseClass: "Error", ResponseCode: "ErrorItemNotFound" },
		];
		const { service } = setup({ reply: () => Response.json({ Body: { ResponseMessages: { Items: items } } }) });
		expect(await service.call("MoveItem", {})).toEqual(items);
	});

	it("names the first error when every response message failed", async () => {
		const items = [
			{ ResponseClass: "Error", ResponseCode: "ErrorItemNotFound" },
			{ ResponseClass: "Error", ResponseCode: "ErrorAccessDenied" },
		];
		const { service } = setup({ reply: () => Response.json({ Body: { ResponseMessages: { Items: items } } }) });
		await expect(service.call("MoveItem", {})).rejects.toThrow("Outlook could not run MoveItem (ErrorItemNotFound).");
	});

	it("refuses a reply with no response message", async () => {
		const { service } = setup({ reply: () => Response.json({ Body: { ResponseMessages: { Items: [] } } }) });
		await expect(service.call("MoveItem", {})).rejects.toThrow("Outlook sent a reply this tool does not understand.");
	});

	it("names a response message error by its code only", async () => {
		const reply = () =>
			Response.json({
				Body: {
					ResponseMessages: {
						Items: [{ ResponseClass: "Error", ResponseCode: "ErrorItemNotFound", MessageText: "test.person@example.com" }],
					},
				},
			});
		const { service } = setup({ reply });
		const error = await service.call("GetItem", {}).catch((caught: Error) => caught);
		expect((error as Error).message).toBe("Outlook could not run GetItem (ErrorItemNotFound).");
	});

	it("does not echo an unexpected response code", async () => {
		const reply = () =>
			Response.json({ Body: { ResponseMessages: { Items: [{ ResponseClass: "Error", ResponseCode: "fixture-token leak" }] } } });
		const { service } = setup({ reply });
		await expect(service.call("GetItem", {})).rejects.toThrow("Outlook could not run GetItem (unknown error).");
	});

	it("refuses a reply it does not understand", async () => {
		const { service } = setup({ reply: () => new Response("<html>", { status: 200 }) });
		await expect(service.call("FindItem", {})).rejects.toThrow("Outlook sent a reply this tool does not understand.");
	});

	it("puts no header value in the error text when the network call fails", async () => {
		const { service } = setup({
			reply: () => {
				throw new Error(`failed with ${HEADERS.authorization} ${HEADERS["x-owa-canary"]}`);
			},
		});
		const error = (await service.call("FindItem", {}).catch((caught: Error) => caught)) as Error;
		expect(error.message).toBe("Outlook did not answer.");
		for (const value of Object.values(HEADERS)) expect(String(error.stack ?? "") + error.message).not.toContain(value);
	});

	it("waits for the headers and then calls", async () => {
		let ready: Record<string, string> | undefined;
		const { service, sent, clock } = setup({ headers: () => ready });
		const pending = service.call("FindItem", {});
		await Promise.resolve();
		clock.now = 4_000;
		ready = HEADERS;
		await pending;
		expect(sent).toHaveLength(1);
	});

	it("rejects with the still-loading message after 10 seconds with no headers", async () => {
		const { service, sent, clock } = setup({ headers: () => undefined });
		await expect(service.call("FindItem", {})).rejects.toThrow(OUTLOOK_STILL_LOADING);
		expect(clock.now).toBeGreaterThanOrEqual(10_000);
		expect(clock.now).toBeLessThan(10_500);
		expect(sent).toEqual([]);
	});

	it("keeps at most 4 calls in flight", async () => {
		let open = 0;
		let peak = 0;
		const releases: Array<() => void> = [];
		const { service } = setup({
			reply: async () => {
				open += 1;
				peak = Math.max(peak, open);
				await new Promise<void>((resolve) => releases.push(resolve));
				open -= 1;
				return Response.json(OK);
			},
		});
		const calls = Array.from({ length: 6 }, () => service.call("FindItem", {}));
		for (let round = 0; round < 10; round += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
			releases.splice(0).forEach((release) => release());
		}
		await Promise.all(calls);
		expect(peak).toBe(4);
	});

	it("never sends a queued call whose signal aborts while it waits for a slot", async () => {
		const releases: Array<() => void> = [];
		const { service, sent } = setup({
			reply: async () => {
				await new Promise<void>((resolve) => releases.push(resolve));
				return Response.json(OK);
			},
		});
		const busy = Array.from({ length: 4 }, () => service.call("FindItem", {}));
		const controller = new AbortController();
		const queued = service.call("CreateItem", {}, controller.signal);
		await new Promise((resolve) => setTimeout(resolve, 0));
		controller.abort();
		releases.splice(0).forEach((release) => release());
		await Promise.all(busy);
		await expect(queued).rejects.toThrow(OUTLOOK_CANCELED);
		expect(sent.map((entry) => new URL(entry.url).searchParams.get("action"))).toEqual(Array(4).fill("FindItem"));
	});

	it("never sends a queued call after the tab switched to another account", async () => {
		const releases: Array<() => void> = [];
		const location = { origin: "https://outlook.live.com", hostname: "outlook.live.com", pathname: "/mail/0/" };
		const { service, sent } = setup({
			location,
			reply: async () => {
				await new Promise<void>((resolve) => releases.push(resolve));
				return Response.json(OK);
			},
		});
		const busy = Array.from({ length: 4 }, () => service.call("FindItem", {}));
		const queued = service.call("CreateItem", {});
		await new Promise((resolve) => setTimeout(resolve, 0));
		location.pathname = "/mail/1/";
		releases.splice(0).forEach((release) => release());
		await Promise.all(busy);
		await expect(queued).rejects.toThrow(OUTLOOK_ACCOUNT_CHANGED);
		expect(sent.map((entry) => new URL(entry.url).pathname)).toEqual(Array(4).fill("/owa/0/service.svc"));
	});

	it("never sends a queued call after the endpoint's mailbox anchor changed", async () => {
		const releases: Array<() => void> = [];
		let held: Record<string, string> = HEADERS;
		const { service, sent } = setup({
			headers: () => held,
			reply: async () => {
				await new Promise<void>((resolve) => releases.push(resolve));
				return Response.json(OK);
			},
		});
		const busy = Array.from({ length: 4 }, () => service.call("FindItem", {}));
		const queued = service.call("CreateItem", {});
		await new Promise((resolve) => setTimeout(resolve, 0));
		held = { ...HEADERS, authorization: "Bearer fixture-token-b", "x-anchormailbox": "PUID:fixture-b@example.com" };
		releases.splice(0).forEach((release) => release());
		await Promise.all(busy);
		await expect(queued).rejects.toThrow(OUTLOOK_ACCOUNT_CHANGED);
		expect(sent).toHaveLength(4);
	});

	it("passes the signal to the page fetch", async () => {
		const { service, sent } = setup();
		const controller = new AbortController();
		await service.call("GetItem", {}, controller.signal);
		expect(sent[0]?.init.signal).toBe(controller.signal);
	});
});
