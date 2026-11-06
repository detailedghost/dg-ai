import { describe, expect, it } from "bun:test";
import { CHAT_PROTOCOL_VERSION, validateChatFrame } from "../src/index";
import {
	INBOX_MAX_CACHE_BYTES,
	INBOX_MAX_MESSAGE_IDS,
	INBOX_MAX_PAGE_SIZE,
	INBOX_RELAY,
	validateInboxBrowserRequest,
	validateInboxBrowserResponse,
	validateInboxCliRequest,
	validateInboxProfile,
} from "../src/inbox-format";
import { inboxBrowserRequest, inboxCliRequest, inboxProfile } from "./utils/inbox-fixtures";

describe("validateInboxProfile", () => {
	it("round-trips helpful provider settings and environment credential references", () => {
		const profile = inboxProfile();
		expect(validateInboxProfile(JSON.parse(JSON.stringify(profile)))).toEqual(profile);
	});

	it.each([null, {}, { provider: "imap" }, inboxProfile({ accessToken: "sensitive-token" }), inboxProfile({ gmail: { clientId: "id", clientSecret: "inline-secret" } })])(
		"rejects malformed or inline-secret configuration %p", (input) => {
			expect(() => validateInboxProfile(input)).toThrow();
		},
	);
});

describe("validateInboxBrowserRequest", () => {
	it.each([
		{ operation: "session-status" },
		{ operation: "list-folders" },
		{ operation: "list-filters" },
		{ operation: "list-messages", page: 0, pageSize: 1 },
		{ operation: "create-folder", name: "Reviewed", type: "folder" },
		{ operation: "rename-folder", id: "folder-a", name: "Reviewed" },
		{ operation: "rename-folder", id: "folder-a", name: "Reviewed", moveToRoot: true },
		{ operation: "delete-folder", id: "folder-a" },
		{ operation: "create-filter", name: "Reviewed", sieve: "keep;", enabled: true },
		{ operation: "reorder-filters", ids: ["filter-a", "filter-b"] },
		{ operation: "update-filter", id: "filter-a", enabled: false },
		{ operation: "delete-filter", id: "filter-a" },
		{ operation: "move-messages", messageIds: ["message-a"], targetFolderId: "folder-a" },
		{ operation: "mark-read", messageIds: ["message-a"] },
		{ operation: "unlabel-messages", messageIds: ["message-a"], labelId: "label-a" },
	])("accepts reviewed fixed operation %p", (request) => {
		expect(validateInboxBrowserRequest(request)).toMatchObject(request);
	});

	it.each([
		{ operation: "rename-folder", id: "folder-a", name: "Reviewed", moveToRoot: "yes" },
		{ operation: "rename-folder", id: "folder-a", name: "Reviewed", moveToRoot: true, parentId: "folder-b" },
		{ operation: "create-folder", name: "Reviewed", moveToRoot: true },
	])("rejects an ambiguous or misplaced root move %p", (request) => {
		expect(() => validateInboxBrowserRequest(request)).toThrow();
	});

	it("preserves a bounded page offset independently of page size", () => {
		const request = inboxBrowserRequest({ page: 31, pageSize: INBOX_MAX_PAGE_SIZE });
		expect(validateInboxBrowserRequest(request)).toEqual(request);
	});

	it.each([
		{ operation: "evaluate", source: "document.cookie" },
		{ operation: "fetch", url: "https://untrusted.example" },
		{ operation: "list-messages", source: "document.cookie" },
		{ operation: "list-messages", page: -1 },
		{ operation: "list-messages", page: 0.5 },
		{ operation: "list-messages", pageSize: 0 },
		{ operation: "list-messages", pageSize: INBOX_MAX_PAGE_SIZE + 1 },
		{ operation: "move-messages", messageIds: [], targetFolderId: "folder-a" },
		{ operation: "move-messages", messageIds: ["message-a"] },
		{ operation: "mark-read", messageIds: Array.from({ length: INBOX_MAX_MESSAGE_IDS + 1 }, (_, i) => `message-${i}`) },
	])("rejects unsupported, executable, or unbounded input %p", (request) => {
		expect(() => validateInboxBrowserRequest(request)).toThrow();
	});

	it("accepts a mutation exactly at the identifier bound", () => {
		const request = inboxBrowserRequest({
			operation: "mark-read", page: undefined, pageSize: undefined,
			messageIds: Array.from({ length: INBOX_MAX_MESSAGE_IDS }, (_, i) => `message-${i}`),
		});
		expect(validateInboxBrowserRequest(request)).toEqual(request);
	});
});

describe("validateInboxCliRequest", () => {
	it("preserves a correlated browser request", () => {
		const request = inboxCliRequest({ timeoutMs: 100 });
		expect(validateInboxCliRequest(request)).toEqual(request);
	});

	it.each([undefined, "", 1])("rejects missing or malformed requestId %p", (requestId) => {
		expect(() => validateInboxCliRequest(inboxCliRequest({ requestId }))).toThrow();
	});

	it.each([0, -1, 0.5, Number.MAX_SAFE_INTEGER])("rejects unbounded deadline %p", (timeoutMs) => {
		expect(() => validateInboxCliRequest(inboxCliRequest({ timeoutMs }))).toThrow();
	});

	it("rejects oversized OAuth material on the internal cache operation", () => {
		expect(() => validateInboxCliRequest(inboxCliRequest({
			operation: "cache-set", request: undefined, name: "personal", provider: "gmail",
			cache: "x".repeat(INBOX_MAX_CACHE_BYTES + 1),
		}))).toThrow();
	});
});

describe("validateChatFrame — inbox browser relay", () => {
	function reply(overrides: Record<string, unknown> = {}) {
		return { type: "inbox-browser-result" as const, sessionId: "session-a", requestId: "request-a", token: "token-a", protocolVersion: CHAT_PROTOCOL_VERSION, ok: true, data: { messages: [], hasMore: false }, ...overrides };
	}

	it("accepts an authenticated correlated extension result", () => {
		const frame = reply();
		expect(validateChatFrame(frame)).toEqual(frame);
	});

	it.each([{ requestId: undefined }, { token: undefined }, { sessionId: "" }, { ok: "true" }, { data: { messages: [{ id: "m", body: "raw-email-body", headers: { Authorization: "sensitive" } }] } }])(
		"rejects uncorrelated or secret-bearing result %p", (change) => {
			expect(() => validateChatFrame(reply(change))).toThrow();
		},
	);
});

describe("validateInboxBrowserResponse", () => {
	function message() {
		return { id: "message-a", from: "[email:example.test]", fromDomain: "example.test", subject: "Redacted subject", snippet: "Redacted preview", folderId: "folder-a" };
	}

	it("preserves a complete normalized metadata page", () => {
		const page = { messages: [message()], hasMore: true };
		expect(validateInboxBrowserResponse(page)).toEqual(page);
	});

	it.each([{ body: "raw-email-body" }, { headers: { Authorization: "sensitive-token" } }, { cookies: "session-cookie" }])("rejects sensitive fields added to otherwise valid metadata %p", (extra) => {
		expect(() => validateInboxBrowserResponse({ messages: [{ ...message(), ...extra }] })).toThrow();
	});

	it("rejects a page larger than the allowed message count", () => {
		expect(() => validateInboxBrowserResponse({ messages: Array.from({ length: INBOX_MAX_PAGE_SIZE + 1 }, message) })).toThrow();
	});
});

describe("validateInboxCliRequest — cache byte limit", () => {
	it("counts UTF-8 bytes rather than JavaScript characters for OAuth cache limits", () => {
		const cache = "é".repeat(INBOX_MAX_CACHE_BYTES / 2);
		const input = inboxCliRequest({ operation: "cache-set", request: undefined, name: "personal", provider: "gmail", cache });
		expect(validateInboxCliRequest(input)).toMatchObject({ cache });
		expect(() => validateInboxCliRequest({ ...input, cache: cache + "é" })).toThrow();
	});
});

describe("INBOX_RELAY table", () => {
	const version = INBOX_RELAY.checks.flatMap((entry) =>
		entry.check === "version" ? [entry] : [],
	)[0];

	it("names the feature and its four frames", () => {
		expect(INBOX_RELAY.name).toBe("inbox");
		expect(INBOX_RELAY.frames).toEqual({
			cliRequest: "cli-inbox-request",
			cliResult: "cli-inbox-result",
			browserRequest: "inbox-browser-request",
			browserResult: "inbox-browser-result",
		});
	});

	it("pins the caps and flags", () => {
		expect(INBOX_RELAY.caps).toEqual({
			pending: 128,
			perRequester: 8,
			sessionIds: 10_000,
		});
		expect("rejected" in INBOX_RELAY).toBe(false);
		expect("rejected" in INBOX_RELAY.strings).toBe(false);
		expect(INBOX_RELAY.flags.failAllOnUnreadable).toBe(false);
	});

	it("lists the checks in refusal order", () => {
		expect(INBOX_RELAY.checks.map((entry) => entry.check)).toEqual([
			"active",
			"pendingDuplicate",
			"cap",
			"replay",
			"cap",
			"burn",
			"peers",
			"version",
		]);
	});

	it.each(["1.11.0", "2.0.0", "1.11.0+build.1", "1.12.3"])(
		"accepts extension version %s",
		(value) => {
			expect(version?.accepts(value)).toBe(true);
		},
	);

	it.each([
		"1.10.99",
		"1.11.0-beta",
		"01.11.0",
		"1.011.0",
		"1.11",
		"1.11.0.1",
		undefined,
	])("refuses extension version %s", (value) => {
		expect(version?.accepts(value)).toBe(false);
	});

	it("uses the request deadline or the inbox default", () => {
		expect(INBOX_RELAY.timeoutMs(inboxCliRequest({ timeoutMs: 250 }))).toBe(250);
		expect(INBOX_RELAY.timeoutMs(inboxCliRequest())).toBe(30_000);
	});

	it("sends only the request in the browser frame", () => {
		const cli = inboxCliRequest({ request: { operation: "list-folders" } });
		expect(INBOX_RELAY.toBrowserRequest(cli)).toEqual({
			request: { operation: "list-folders" },
		});
		expect(Object.keys(INBOX_RELAY.toBrowserRequest(cli))).toEqual([
			"request",
		]);
	});

	it("reads the request back from the browser frame", () => {
		expect(
			INBOX_RELAY.fromBrowserRequest({
				requestId: "r",
				request: { operation: "list-folders" },
			}),
		).toEqual({ operation: "list-folders" });
	});

	it("turns an ok result into a validated value and a failure into an error", () => {
		const data = { folders: [{ id: "folder-a", name: "Reviewed" }] };
		expect(INBOX_RELAY.toCliResult({ requestId: "r", ok: true, data })).toEqual({
			ok: true,
			value: data,
		});
		expect(
			INBOX_RELAY.toCliResult({ requestId: "r", ok: false, error: "expired" }),
		).toEqual({ ok: false, error: "expired" });
	});
});
