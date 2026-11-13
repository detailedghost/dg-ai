import { describe, expect, it } from "bun:test";
import {
	formatNetwork,
	maskCredentialFields,
	isSensitiveHeader,
	looksLikeOpaqueId,
	type NetworkEntry,
	networkUrlShape,
	renderNetworkShape,
	validateNetworkEntries,
} from "../src/pw-ext-network";

const AT = 1_731_500_000_000;

const entry = (patch: Partial<NetworkEntry> = {}): NetworkEntry => ({
	at: AT,
	via: "fetch",
	method: "POST",
	url: "https://mail.example.test/owa/0/service.svc?action=FindConversation&app=Mail&n=42",
	status: 200,
	requestHeaders: [{ name: "content-type" }, { name: "authorization" }],
	responseHeaders: [{ name: "content-type" }],
	...patch,
});

describe("looksLikeOpaqueId", () => {
	it.each([
		"AAMkADU3ZmFrZWZha2VmYWtlZmFrZQ",
		"3f2c9a1e-0b7d-4c55-9e21-7a0f00c0ffee",
		"x7Kq2mPz9Lw4Rt6Yv8Nb1Hc3",
		"abc%2Fdef%3D%3Dghi12",
	])("masks %s", (value) => expect(looksLikeOpaqueId(value)).toBe(true));

	it.each(["FindConversation", "service.svc", "username", "inbox", "v1.0", "conversationlistview", "search-box-2"])(
		"keeps %s",
		(value) => expect(looksLikeOpaqueId(value)).toBe(false),
	);
});

describe("networkUrlShape", () => {
	it("removes query values but keeps the allowlisted API names", () => {
		expect(networkUrlShape("https://mail.example.test/owa/0/service.svc?action=FindConversation&app=Mail&n=42")).toBe(
			"https://mail.example.test/owa/0/service.svc?action=FindConversation&app=Mail&n=*",
		);
	});

	it("removes an allowlisted value that is not a plain API name", () => {
		expect(networkUrlShape("https://a.test/x?action=Get%20Item&app=AAMkADU3ZmFrZWZha2VmYWtlZmFrZQ")).toBe(
			"https://a.test/x?action=*&app=*",
		);
	});

	it("masks id-like path segments, odd parameter names, user info and the fragment", () => {
		expect(
			networkUrlShape(
				"https://user:pw@a.test/api/users/1234567/items/AAMkADU3ZmFrZWZha2VmYWtlZmFrZQ/person%40example.test?fake.person@example.test=1&q#frag",
			),
		).toBe("https://a.test/api/users/*/items/*/*?*=*&q");
	});

	it("shows only the scheme of a non-web URL", () => {
		expect(networkUrlShape("data:application/json,{}")).toBe("data:");
		expect(networkUrlShape("not a url")).toBe("(unparsable URL)");
	});
});

describe("renderNetworkShape", () => {
	it("renders key structure and value types, never values", () => {
		expect(
			renderNetworkShape({
				keys: [
					["__type", "string"],
					["Body", { keys: [["ItemIds", { n: 2, of: { keys: [["Id", "string"]] } }], ["Count", "number"]] }],
					["fake.person@example.test", "string"],
					["Empty", { n: 0 }],
				],
				more: 3,
			}),
		).toBe("{__type string, Body {ItemIds [2 x {Id string}], Count number}, * string, Empty [0], +3 more}");
	});
});

describe("maskCredentialFields", () => {
	it.each([
		['{"access_token":"fake-opaque-1","refresh_token":"fake-opaque-2","expires_in":3600}', '{"access_token":"[redacted]","refresh_token":"[redacted]","expires_in":3600}'],
		['{"user":"ada","password":"hunter2"}', '{"user":"ada","password":"[redacted]"}'],
		['{"Body":{"SessionId":12345,"Subject":"Hi"}}', '{"Body":{"SessionId":"[redacted]","Subject":"Hi"}}'],
		['{"apiKey":"fake-key","note":"a \\"quoted\\" word"}', '{"apiKey":"[redacted]","note":"a \\"quoted\\" word"}'],
		['{"client_secret":"fake-cut-val', '{"client_secret":"[redacted]"'],
		["user=ada&passwd=hunter2&remember=1", "user=ada&passwd=[redacted]&remember=1"],
		["https://a.test/cb?code=fake-code&state=s1#x", "https://a.test/cb?code=[redacted]&state=s1#x"],
		['{"Subject":"token talk","Count":2}', '{"Subject":"token talk","Count":2}'],
	])("masks %s", (input, output) => expect(maskCredentialFields(input)).toBe(output));
});

describe("isSensitiveHeader", () => {
	it.each(["Authorization", "cookie", "Set-Cookie", "X-OWA-CANARY", "x-csrf-token", "X-Api-Key", "proxy-authorization"])(
		"withholds %s",
		(name) => expect(isSensitiveHeader(name)).toBe(true),
	);
	it.each(["content-type", "action", "x-req-source", "accept"])("shows %s", (name) =>
		expect(isSensitiveHeader(name)).toBe(false),
	);
});

describe("validateNetworkEntries", () => {
	it("accepts a well-formed entry list", () => {
		expect(validateNetworkEntries({ entries: [entry()] })).toEqual([entry()]);
	});

	it.each([
		["a non-array", { entries: "x" }],
		["an unknown field", { entries: [{ ...entry(), extra: 1 }] }],
		["a bad via", { entries: [{ ...entry(), via: "ws" }] }],
		["a header with a non-string value", { entries: [entry({ requestHeaders: [{ name: "a", value: 1 as never }] })] }],
		["a deep shape", { entries: [entry({ response: { type: "application/json", size: 1, shape: deep(20) } })] }],
	])("refuses %s", (_, raw) => expect(() => validateNetworkEntries(raw)).toThrow());
});

function deep(depth: number): NonNullable<NonNullable<NetworkEntry["response"]>["shape"]> {
	return depth === 0 ? "string" : { keys: [["a", deep(depth - 1)]] };
}

describe("formatNetwork", () => {
	const value = (text: string) => text;

	it("prints shape only by default", () => {
		const out = formatNetwork(
			[
				entry({
					request: { type: "application/json", size: 40, shape: { keys: [["Body", { keys: [["Id", "string"]] }]] }, text: '{"Body":{"Id":"fake-item"}}' },
					response: { type: "text/html", size: 1200 },
					requestHeaders: [{ name: "authorization", value: "Bearer fake-token-value-for-tests" }, { name: "action", value: "FindConversation" }],
				}),
			],
			{ values: false, value },
		);
		expect(out.join("\n")).toContain("fetch POST https://mail.example.test/owa/0/service.svc?action=FindConversation&app=Mail&n=* → 200");
		expect(out).toContain("  request headers: authorization, action");
		expect(out).toContain("  request body: application/json, 40 bytes {Body {Id string}}");
		expect(out).toContain("  response body: text/html, 1200 bytes");
		expect(out.join("\n")).not.toContain("fake-item");
		expect(out.join("\n")).not.toContain("fake-token-value-for-tests");
		expect(out.join("\n")).not.toContain("FindConversation\n");
	});

	it("prints values through the mask, and never a sensitive header value", () => {
		const out = formatNetwork(
			[
				entry({
					request: { type: "application/json", size: 27, text: '{"Body":{"Id":"fake-item"}}' },
					requestHeaders: [{ name: "Authorization", value: "Bearer fake-token-value-for-tests" }, { name: "action", value: "FindConversation" }],
				}),
			],
			{ values: true, value: (text) => text.replaceAll("fake-item", "[masked]") },
		).join("\n");
		expect(out).toContain("n=42");
		expect(out).toContain("Authorization (hidden)");
		expect(out).toContain("action: FindConversation");
		expect(out).toContain('{"Body":{"Id":"[masked]"}}');
		expect(out).not.toContain("fake-token-value-for-tests");
	});

	it("masks credential fields in bodies and addresses before value()", () => {
		const out = formatNetwork(
			[
				entry({
					url: "https://a.test/token?grant=x&refresh_token=fake-refresh",
					request: { type: "application/x-www-form-urlencoded", size: 30, text: "username=ada&password=hunter2" },
					response: { type: "application/json", size: 60, text: '{"access_token":"fake-opaque","token_type":"Bearer"}', cut: true },
				}),
			],
			{ values: true, value },
		).join("\n");
		expect(out).toContain("refresh_token=[redacted]");
		expect(out).toContain("password=[redacted]");
		expect(out).toContain('"access_token":"[redacted]"');
		expect(out).toContain('"token_type":"[redacted]"}…');
		for (const secret of ["fake-refresh", "hunter2", "fake-opaque"]) expect(out).not.toContain(secret);
	});

	it("filters on the shape URL so a hidden value cannot be probed", () => {
		const entries = [entry({ url: "https://a.test/x?q=fake-needle" }), entry({ url: "https://a.test/needle" })];
		expect(formatNetwork(entries, { values: false, value, filter: "needle" }).join("\n")).not.toContain("?q=");
		expect(formatNetwork(entries, { values: true, value, filter: "fake-needle" }).join("\n")).toContain("No request matches");
	});

	it("keeps the newest entries within the limit and shows pending and failed ones", () => {
		const entries = [1, 2, 3].map((n) => entry({ at: AT + n, url: `https://a.test/p${n}` }));
		entries.push(entry({ at: AT + 4, url: "https://a.test/pending", status: undefined }));
		entries.push(entry({ at: AT + 5, url: "https://a.test/failed", status: undefined, failed: true }));
		const out = formatNetwork(entries, { values: false, value, limit: 3 }).join("\n");
		expect(out).not.toContain("/p1");
		expect(out).not.toContain("/p2");
		expect(out).toContain("/p3 → 200");
		expect(out).toContain("/pending → pending");
		expect(out).toContain("/failed → failed");
		expect(out).toContain("3 of 5 requests");
		expect(out).toContain(`--since ${AT + 5}`);
	});
});
