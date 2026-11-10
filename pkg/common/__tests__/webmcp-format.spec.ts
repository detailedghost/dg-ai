import { describe, expect, it } from "bun:test";
import {
	approvalClassOf,
	BUILT_IN_SCRIPTS,
	isDgToolName,
	validateWebMcpScriptRecord,
	WEBMCP_MAX_MATCHES,
	WEBMCP_TOOL_CLASSES,
	type WebMcpApprovalClass,
	type WebMcpScriptRecord,
} from "../src/webmcp-format";

const RECORD: WebMcpScriptRecord = {
	id: "notes-helper",
	name: "Notes helper",
	matches: ["https://notes.example.test/*"],
	sha256: "a".repeat(64),
	source: "paste",
	enabled: true,
};

describe("approvalClassOf", () => {
	it.each<[string, WebMcpApprovalClass | undefined]>([
		["dg_outlook_list", "read"],
		["dg_outlook_search", "read"],
		["dg_outlook_read", "read"],
		["dg_outlook_mark_read", "session"],
		["dg_outlook_flag", "session"],
		["dg_outlook_move", "session"],
		["dg_outlook_archive", "session"],
		["dg_outlook_draft", "session"],
		["dg_outlook_delete", "each"],
		["dg_outlook_reply", "each"],
		["dg_outlook_unknown", "each"],
		["dg_x", "each"],
		["search_flights", undefined],
		["constructor", undefined],
		["toString", undefined],
	])("gives %s the class %s", (name, expected) => {
		expect(approvalClassOf(name)).toBe(expected);
	});

	it("classifies exactly the ten Outlook tools", () => {
		expect(Object.keys(WEBMCP_TOOL_CLASSES)).toHaveLength(10);
		expect(Object.keys(WEBMCP_TOOL_CLASSES).every(isDgToolName)).toBe(true);
	});
});

describe("approvalClassOf with an origin", () => {
	it.each<[string, string, WebMcpApprovalClass | undefined]>([
		["dg_outlook_list", "https://outlook.live.com", "read"],
		["dg_outlook_list", "https://outlook.office.com", "read"],
		["dg_outlook_move", "https://outlook.live.com", "session"],
		["dg_outlook_delete", "https://outlook.live.com", "each"],
		["dg_outlook_list", "https://mail.proton.me", "each"],
		["dg_outlook_move", "https://evil.example", "each"],
		["dg_outlook_list", "https://outlook.live.com.evil.example", "each"],
		["dg_outlook_list", "http://outlook.live.com", "each"],
		["dg_other_list", "https://outlook.live.com", "each"],
		["search_flights", "https://evil.example", undefined],
	])("gives %s on %s the class %s", (name, origin, expected) => {
		expect(approvalClassOf(name, origin)).toBe(expected);
	});
});

describe("isDgToolName", () => {
	it.each(["dg_outlook_list", "dg_outlook_mark_read", "dg_site9_a1"])("accepts %s", (name) => {
		expect(isDgToolName(name)).toBe(true);
	});

	it.each(["dg_x", "dg_", "dg__list", "dg_Outlook_list", "DG_outlook_list", "search_flights", "dg_outlook_list\n", "dg_out-look_list", ""])(
		"rejects %p",
		(name) => {
			expect(isDgToolName(name)).toBe(false);
		},
	);
});

describe("BUILT_IN_SCRIPTS", () => {
	it("holds the Outlook script for both Outlook origins", () => {
		expect(BUILT_IN_SCRIPTS).toEqual([
			{
				id: "outlook",
				name: "Outlook on the web",
				matches: ["https://outlook.office.com/*", "https://outlook.live.com/*"],
			},
		]);
	});
});

describe("validateWebMcpScriptRecord", () => {
	it("accepts a record with and without approvedAt", () => {
		expect(validateWebMcpScriptRecord(RECORD)).toEqual(RECORD);
		const approved: WebMcpScriptRecord = { ...RECORD, approvedAt: 1_700_000_000_000, source: "file" };
		expect(validateWebMcpScriptRecord(approved)).toEqual(approved);
	});

	it.each([
		["a non-object", "text"],
		["an unknown field", { ...RECORD, code: "x" }],
		["an empty id", { ...RECORD, id: "" }],
		["an upper-case id", { ...RECORD, id: "Notes" }],
		["an empty name", { ...RECORD, name: " " }],
		["no matches", { ...RECORD, matches: [] }],
		["too many matches", { ...RECORD, matches: Array.from({ length: WEBMCP_MAX_MATCHES + 1 }, (_, i) => `https://h${i}.example.test/*`) }],
		["an http match", { ...RECORD, matches: ["http://notes.example.test/*"] }],
		["a match with no path", { ...RECORD, matches: ["https://notes.example.test"] }],
		["a match for every host", { ...RECORD, matches: ["https://*/*"] }],
		["a wildcard scheme", { ...RECORD, matches: ["*://notes.example.test/*"] }],
		["a short sha256", { ...RECORD, sha256: "abc" }],
		["an upper-case sha256", { ...RECORD, sha256: "A".repeat(64) }],
		["an unknown source", { ...RECORD, source: "url" }],
		["a non-boolean enabled", { ...RECORD, enabled: "yes" }],
		["a negative approvedAt", { ...RECORD, approvedAt: -1 }],
		["a non-number approvedAt", { ...RECORD, approvedAt: "now" }],
	])("rejects %s", (_label, value) => {
		expect(() => validateWebMcpScriptRecord(value)).toThrow();
	});

	it("accepts a wildcard subdomain match", () => {
		const value = { ...RECORD, matches: ["https://*.example.test/app/*"] };
		expect(validateWebMcpScriptRecord(value)).toEqual(value);
	});
});

describe("validateWebMcpScriptRecord wildcard hosts", () => {
	it.each(["https://*.com/*", "https://*.io/*", "https://*.example/*"])("rejects the top-level wildcard %s", (match) => {
		expect(() => validateWebMcpScriptRecord({ ...RECORD, matches: [match] })).toThrow("match pattern");
	});

	it.each(["https://*.example.com/*", "https://*.shop.example.co.uk/path/*", "https://example.com/*"])(
		"accepts %s",
		(match) => {
			expect(validateWebMcpScriptRecord({ ...RECORD, matches: [match] }).matches).toEqual([match]);
		},
	);
});
