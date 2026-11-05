import { describe, expect, it } from "bun:test";
import { CHAT_PROTOCOL_VERSION, validateChatFrame } from "../src/index";
import {
	PW_EXT_MAX_IMAGE_CHARS,
	PW_EXT_MAX_TEXT_CHARS,
	PW_EXT_MAX_TIMEOUT_MS,
	isPwExtWriteVerb,
	validatePwExtCliRequest,
	validatePwExtRequest,
	validatePwExtResponse,
} from "../src/pw-ext-format";

describe("validatePwExtRequest", () => {
	it.each([
		{ verb: "current" },
		{ verb: "snapshot" },
		{ verb: "screenshot" },
		{ verb: "selection" },
		{ verb: "console" },
		{ verb: "open", url: "https://example.com/a?b=1" },
		{ verb: "open", url: "http://127.0.0.1:3000/" },
		{ verb: "click", target: "e12" },
		{ verb: "click", target: "#save" },
		{ verb: "fill", target: "e3", value: "" },
		{ verb: "fill", target: "input[name=q]", value: "hello" },
	])("accepts %p", (request) => {
		expect(validatePwExtRequest(request)).toEqual(request);
	});

	it.each([
		null,
		{},
		{ verb: "eval", code: "1" },
		{ verb: "run-code" },
		{ verb: "current", url: "https://example.com" },
		{ verb: "snapshot", approved: true },
		{ verb: "open" },
		{ verb: "open", url: "chrome://settings" },
		{ verb: "open", url: "javascript:alert(1)" },
		{ verb: "open", url: "file:///etc/passwd" },
		{ verb: "open", url: "data:text/html,hi" },
		{ verb: "open", url: `https://example.com/${"a".repeat(2100)}` },
		{ verb: "click" },
		{ verb: "click", target: "" },
		{ verb: "click", target: "x".repeat(600) },
		{ verb: "fill", target: "e1" },
		{ verb: "fill", target: "e1", value: "v".repeat(5000) },
		{ verb: "fill", target: "e1", value: 3 },
	])("rejects %p", (request) => {
		expect(() => validatePwExtRequest(request)).toThrow();
	});

	it("names only open, click and fill as write verbs", () => {
		expect(
			["current", "snapshot", "screenshot", "selection", "console", "open", "click", "fill"].filter(
				(verb) => isPwExtWriteVerb(verb as never),
			),
		).toEqual(["open", "click", "fill"]);
	});
});

describe("validatePwExtResponse", () => {
	it("accepts text and a screenshot image", () => {
		const value = { text: "ok", image: "data:image/jpeg;base64,AAAA" };
		expect(validatePwExtResponse(value)).toEqual(value);
	});

	it.each([
		{},
		{ text: 1 },
		{ text: "x".repeat(PW_EXT_MAX_TEXT_CHARS + 1) },
		{ text: "ok", image: "https://example.com/a.png" },
		{ text: "ok", image: "data:text/html;base64,AAAA" },
		{ text: "ok", image: `data:image/png;base64,${"A".repeat(PW_EXT_MAX_IMAGE_CHARS)}` },
		{ text: "ok", cookies: "a=b" },
	])("rejects %p", (value) => {
		expect(() => validatePwExtResponse(value)).toThrow();
	});
});

describe("validatePwExtCliRequest", () => {
	const base = {
		type: "cli-pw-ext-request" as const,
		requestId: "r1",
		request: { verb: "current" as const },
	};

	it("accepts a bounded request", () => {
		expect(validatePwExtCliRequest({ ...base, timeoutMs: 1000 })).toEqual({
			...base,
			timeoutMs: 1000,
		});
	});

	it.each([
		{ ...base, requestId: "" },
		{ ...base, requestId: "r".repeat(129) },
		{ ...base, timeoutMs: 0 },
		{ ...base, timeoutMs: PW_EXT_MAX_TIMEOUT_MS + 1 },
		{ ...base, approved: true },
		{ ...base, request: { verb: "eval" } },
	])("rejects %p", (value) => {
		expect(() => validatePwExtCliRequest(value)).toThrow();
	});
});

describe("pw-ext chat frames", () => {
	const envelope = {
		sessionId: "s1",
		protocolVersion: CHAT_PROTOCOL_VERSION,
		requestId: "r1",
	};

	it("validates the daemon request to the extension", () => {
		const frame = {
			...envelope,
			type: "pw-ext-browser-request",
			request: { verb: "click", target: "e1" },
			timeoutMs: 1000,
		};
		expect(validateChatFrame(frame)).toEqual(frame as never);
		expect(() =>
			validateChatFrame({ ...frame, request: { verb: "eval" } }),
		).toThrow();
		expect(() => validateChatFrame({ ...frame, approved: true })).toThrow();
	});

	it("validates the extension result", () => {
		const ok = {
			...envelope,
			type: "pw-ext-browser-result",
			token: "t",
			ok: true,
			data: { text: "hi" },
		};
		expect(validateChatFrame(ok)).toEqual(ok as never);
		const failed = { ...ok, ok: false, data: undefined, error: "denied" };
		delete (failed as Record<string, unknown>).data;
		expect(validateChatFrame(failed)).toEqual(failed as never);
		expect(() => validateChatFrame({ ...ok, error: "x" })).toThrow();
		expect(() =>
			validateChatFrame({ ...ok, data: { text: "x".repeat(PW_EXT_MAX_TEXT_CHARS + 1) } }),
		).toThrow();
		expect(() => validateChatFrame({ ...ok, extra: 1 })).toThrow();
	});
});
