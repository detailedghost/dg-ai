import { expect, it, mock } from "bun:test";
import type { InboxBrowserRequest } from "@dg/common";
import { executeProtonPage } from "../lib/features/inbox-proton";

const headers = {
	uid: "private-session-uid",
	appVersion: "web-mail@5.0.0",
	locale: "en_US",
};

function providerFetch(body: unknown, status = 200) {
	return mock(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	}));
}

function context(fetch: ReturnType<typeof providerFetch>, overrides = {}) {
	return { origin: "https://mail.proton.me", headers, fetch, ...overrides };
}

it("fetches a fixed message page and normalizes summaries without bodies or session material", async () => {
	const fetch = providerFetch({ Messages: [{
		ID: "opaque-provider-message-id",
		Sender: { Address: "customer@example.test", Name: "Customer" },
		Subject: "Account 1234567890123456 call +1 (312) 555-0199",
		Context: "Write customer@example.test",
		Body: "raw encrypted or decrypted message body",
		LabelIDs: ["0"], Unread: 1, Time: 1780000000,
		AccessToken: "unexpected-secret-field",
	}], Total: 51 });
	const result = await executeProtonPage({ operation: "list-messages", page: 1, pageSize: 50, folderId: "0" }, context(fetch));
	const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
	const endpoint = new URL(url, "https://mail.proton.me");
	expect(endpoint.origin).toBe("https://mail.proton.me");
	expect(endpoint.pathname).toBe("/api/mail/v4/messages");
	expect(endpoint.searchParams.get("Page")).toBe("1");
	expect(endpoint.searchParams.get("PageSize")).toBe("50");
	expect(endpoint.searchParams.get("LabelID[]")).toBe("0");
	expect(init.credentials).toBe("include");
	expect(new Headers(init.headers).get("x-pm-uid")).toBe(headers.uid);
	expect(result.messages).toHaveLength(1);
	expect(result.messages?.[0]?.id).toBe("opaque-provider-message-id");
	expect(result.messages?.[0]?.read).toBe(false);
	const serialized = JSON.stringify(result);
	for (const secret of [headers.uid, headers.appVersion, "customer@example.test", "1234567890123456", "312", "raw encrypted", "unexpected-secret-field", "AccessToken", "Body"]) {
		expect(serialized).not.toContain(secret);
	}
});

it("returns system and normalized custom folders without secret fields", async () => {
	const fetch = providerFetch({ Labels: [{ ID: "folder-1", Name: "Receipts", Type: 1, AccessToken: "secret" }] });
	const result = await executeProtonPage({ operation: "list-folders" }, context(fetch));
	expect(result.folders).toEqual(expect.arrayContaining([
		expect.objectContaining({ id: "0", name: "Inbox" }),
		expect.objectContaining({ id: "folder-1", name: "Receipts" }),
	]));
	expect(JSON.stringify(result)).not.toContain("AccessToken");
});

it("normalizes filters without relaying raw response properties", async () => {
	const fetch = providerFetch({ Filters: [{ ID: "filter-1", Name: "Receipts", Status: 1, Sieve: "require [\"fileinto\"];", Secret: "secret" }] });
	const result = await executeProtonPage({ operation: "list-filters" }, context(fetch));
	expect(result.filters).toEqual(expect.arrayContaining([expect.objectContaining({ id: "filter-1", name: "Receipts", enabled: true })]));
	expect(JSON.stringify(result)).not.toContain("Secret");
});

it.each([
	{ operation: "eval", source: "document.cookie" },
	{ operation: "list-messages", source: "document.cookie" },
	{ operation: "list-messages", url: "https://attacker.test" },
	{ operation: "list-messages", pageSize: 100000 },
	{ operation: "list-messages", page: -1 },
])("rejects executable, arbitrary endpoint, or out-of-bounds requests before fetching %j", async (request) => {
	const fetch = providerFetch({ Messages: [] });
	await expect(executeProtonPage(request as never, context(fetch))).rejects.toThrow();
	expect(fetch).not.toHaveBeenCalled();
});

it.each(["https://account.proton.me", "https://mail.proton.me.attacker.test", "http://mail.proton.me"]) (
	"refuses execution outside the authenticated HTTPS mail origin %s", async (origin) => {
		const fetch = providerFetch({ Messages: [] });
		await expect(executeProtonPage({ operation: "list-messages", page: 0, pageSize: 50 }, context(fetch, { origin }))).rejects.toThrow(/Proton|origin/i);
		expect(fetch).not.toHaveBeenCalled();
	},
);

it("reports missing observed headers with a reload or login instruction before making a request", async () => {
	const fetch = providerFetch({ Messages: [] });
	await expect(executeProtonPage({ operation: "list-messages", page: 0, pageSize: 50 }, context(fetch, { headers: undefined }))).rejects.toThrow(/reload|sign in|login/i);
	expect(fetch).not.toHaveBeenCalled();
});

it.each([401, 403])("reports logged out HTTP %i without copying provider error secrets", async (status) => {
	const fetch = providerFetch({ Error: "customer@example.test token=private-secret" }, status);
	let failure = "";
	try { await executeProtonPage({ operation: "list-folders" }, context(fetch)); }
	catch (error) { failure = String(error); }
	expect(failure).toMatch(/sign in|login|authenticated/i);
	expect(failure).not.toContain("customer@example.test");
	expect(failure).not.toContain("private-secret");
});

it("treats Proton's non-success API code as a provider failure even with HTTP 200", async () => {
	const fetch = providerFetch({ Code: 2001, Error: "internal diagnostic" });
	await expect(executeProtonPage({ operation: "list-folders" }, context(fetch))).rejects.toThrow(/Proton|provider|API/i);
});

it("executes reviewed move operations with exact opaque IDs and a fixed endpoint", async () => {
	const fetch = providerFetch({ Code: 1000 });
	await executeProtonPage({ operation: "move-messages", messageIds: ["msg-1", "msg-2"], targetFolderId: "folder-1" }, context(fetch));
	const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
	expect(new URL(url, "https://mail.proton.me").pathname).toBe("/api/mail/v4/messages/label");
	expect(init.method).toBe("PUT");
	expect(JSON.parse(String(init.body))).toEqual({ IDs: ["msg-1", "msg-2"], LabelID: "folder-1" });
});

it.each([0, 1, 60])("keeps fixed PageSize across provider offsets, including an empty page (%i)", async (page) => {
	const fetch = providerFetch({ Code: 1000, Messages: [], Total: 3007 });
	const result = await executeProtonPage({ operation: "list-messages", page, pageSize: 50 }, context(fetch));
	const params = new URL(String(fetch.mock.calls[0][0])).searchParams;
	expect(params.get("Page")).toBe(String(page));
	expect(params.get("PageSize")).toBe("50");
	expect(result.messages).toEqual([]);
	expect(result.hasMore).toBe((page + 1) * 50 < 3007);
});

it.each([
	{ Code: 1001, Responses: [{ ID: "msg-1", Response: { Code: 1000 } }, { ID: "msg-2", Response: { Code: 1000 } }] },
])("accepts a provider batch only when every requested message succeeded", async (body) => {
	const fetch = providerFetch(body);
	await expect(executeProtonPage({ operation: "mark-read", messageIds: ["msg-1", "msg-2"] }, context(fetch))).resolves.toEqual({});
	expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([
	{ Code: 1001, Responses: [{ ID: "msg-1", Response: { Code: 1000 } }, { ID: "msg-2", Response: { Code: 2001 } }] },
	{ Code: 1001, Responses: [{ ID: "msg-1", Response: { Code: 1000 } }] },
	{ Code: 1001, Responses: [{ ID: "msg-1", Response: { Code: 1000 } }, { ID: "unrequested", Response: { Code: 1000 } }] },
	{ Code: 1001 },
	{ Code: 1001, Responses: [{ ID: "msg-1", Response: { Code: 1000 } }, { ID: "msg-2" }] },
])("refuses missing, partial, failed, or unrelated provider batch results %j", async (body) => {
	const fetch = providerFetch(body);
	await expect(executeProtonPage({ operation: "mark-read", messageIds: ["msg-1", "msg-2"] }, context(fetch))).rejects.toThrow(/Proton|complete|API/);
});

it("preserves fresh complete filter policy and status for a name-only update", async () => {
	const policy = 'require ["fileinto"]; if address :is "from" "private@example.test" { fileinto "Receipts"; }';
	const original = { ID: "filter-1", Name: "Original", Sieve: policy, Status: 0 };
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	const fetch = mock(async (url: RequestInfo | URL, init?: RequestInit) => {
		calls.push({ url: String(url), init });
		return new Response(JSON.stringify({ Code: 1000, Filter: calls.length === 1 ? original : { ...original, Name: "Renamed" } }));
	});
	const result = await executeProtonPage({ operation: "update-filter", id: original.ID, name: "Renamed" }, context(fetch));
	expect(calls.map((call) => call.init?.method)).toEqual(["GET", "PUT"]);
	expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ Name: "Renamed", Sieve: policy, Status: 0, Version: 2 });
	expect(result.filter?.conditions).toEqual([policy]);
	expect(result.filter?.actions).toEqual([policy]);
	expect(result.filter?.enabled).toBe(false);
});

it("rejects stale message pages rather than exposing unreliable metadata", async () => {
	const fetch = providerFetch({ Code: 1000, Stale: 1, Messages: [{ ID: "stale-id" }] });
	await expect(executeProtonPage({ operation: "list-messages", page: 0, pageSize: 50 }, context(fetch))).rejects.toThrow(/stale|retry/i);
});

it.each([
	{ operation: "mark-read", messageIds: ["message-1"] },
	{ operation: "move-messages", messageIds: ["message-1"], targetFolderId: "folder-1" },
	{ operation: "unlabel-messages", messageIds: ["message-1"], labelId: "label-1" },
	{ operation: "delete-filter", id: "filter-1" },
] satisfies InboxBrowserRequest[])("executeProtonPage rejects an unacknowledged mutation response %j", async (request) => {
	// A missing provider success code must not become a synthetic successful action.
	const fetch = mock(async () => new Response(JSON.stringify({})));
	await expect(executeProtonPage(request, { origin: "https://mail.proton.me", headers: { uid: "observed-uid" }, fetch })).rejects.toThrow(/Proton|API|response/i);
});

it("executeProtonPage refuses a partial filter update when fresh policy is missing before issuing PUT", async () => {
	// Missing fresh Sieve must not be submitted as an omitted policy with a default status.
	const fetch = mock(async () => new Response(JSON.stringify({ Code: 1000, Filter: { ID: "filter-1", Name: "Original" } })));
	await expect(executeProtonPage({ operation: "update-filter", id: "filter-1", name: "Renamed" }, {
		origin: "https://mail.proton.me", headers: { uid: "observed-uid" }, fetch,
	})).rejects.toThrow(/Proton|policy|response/i);
	expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([
	{ missing: "Sieve", previous: { Sieve: undefined }, request: {} },
	{ missing: "Status", previous: { Status: undefined }, request: {} },
	{ missing: "valid Status", previous: { Status: 2 }, request: {} },
	{ missing: "matching ID", previous: { ID: "unrelated-filter" }, request: {} },
	{ missing: "Name", previous: { Name: undefined }, request: { name: undefined, enabled: true } },
])("executeProtonPage refuses a fresh filter without $missing before partial update", async ({ previous, request }) => {
	const filter = { ID: "filter-1", Name: "Original", Sieve: 'require ["fileinto"];', Status: 0, ...previous };
	const fetch = mock(async () => new Response(JSON.stringify({ Code: 1000, Filter: filter })));
	await expect(executeProtonPage({ operation: "update-filter", id: "filter-1", name: "Renamed", ...request }, {
		origin: "https://mail.proton.me", headers: { uid: "observed-uid" }, fetch,
	})).rejects.toThrow(/Proton|policy|response/i);
	expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([
	{ LabelIDs: ["7", "5"] },
	{ LabelIDs: ["6", "5"] },
	{ LabelIDs: [] },
	{ LabelIDs: undefined },
	{ LabelIDs: ["0", 123] },
	{ LabelIDs: "0" },
])(
	"rejects a scoped Proton page without trustworthy requested-folder membership %j",
	async (membership) => {
		const fetch = providerFetch({
			Code: 1000,
			Messages: [
				{ ID: "inbox-message", LabelIDs: ["0", "5"] },
				{ ID: "outside-message", ...membership },
			],
			Total: 2,
		});
		await expect(
			executeProtonPage(
				{ operation: "list-messages", folderId: "0", pageSize: 50 },
				context(fetch),
			),
		).rejects.toThrow(/folder|scope|membership/i);
	},
);

it("accepts exact custom-folder membership alongside other Proton labels", async () => {
	const fetch = providerFetch({
		Code: 1000,
		Messages: [{ ID: "message", LabelIDs: ["5", "custom-folder", "label"] }],
		Total: 1,
	});
	const result = await executeProtonPage(
		{ operation: "list-messages", folderId: "custom-folder" },
		context(fetch),
	);
	expect(result.messages?.[0]).toMatchObject({
		folderId: "custom-folder",
		labels: ["5", "custom-folder", "label"],
	});
});
