import { describe, expect, it } from "bun:test";
import { CHAT_PROTOCOL_VERSION, validateChatFrame } from "../src/index";
import {
	INBOX_MAX_CACHE_BYTES,
	INBOX_MAX_MESSAGE_IDS,
	INBOX_MAX_PAGE_SIZE,
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
		{ operation: "list-folders" },
		{ operation: "list-filters" },
		{ operation: "list-messages", page: 0, pageSize: 1 },
		{ operation: "create-folder", name: "Reviewed", type: "folder" },
		{ operation: "create-filter", name: "Reviewed", sieve: "keep;", enabled: true },
		{ operation: "update-filter", id: "filter-a", enabled: false },
		{ operation: "delete-filter", id: "filter-a" },
		{ operation: "move-messages", messageIds: ["message-a"], targetFolderId: "folder-a" },
		{ operation: "mark-read", messageIds: ["message-a"] },
		{ operation: "unlabel-messages", messageIds: ["message-a"], labelId: "label-a" },
	])("accepts reviewed fixed operation %p", (request) => {
		expect(validateInboxBrowserRequest(request)).toMatchObject(request);
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
