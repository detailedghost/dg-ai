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
	validatePwExtCliCancel,
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

describe("pw --ext round 3 verbs", () => {
	const upload = {
		verb: "upload",
		target: "e3",
		assetId: "123e4567-e89b-42d3-a456-426614174000",
		fileName: "demo.webm",
		fileSize: 1024,
		fileType: "video/webm",
		filePath: "~/work/demo.webm",
	};

	it.each([
		upload,
		{ verb: "tools" },
		{ verb: "call", tool: "search_issues", args: { query: "bug", limit: 5 } },
		{ verb: "call", tool: "noop", args: {} },
	])("accepts %p", (request) => {
		expect(validatePwExtRequest(request)).toEqual(request as never);
	});

	it.each([
		{ ...upload, assetId: "../x" },
		{ ...upload, fileName: "../secret" },
		{ ...upload, fileName: "a/b.txt" },
		{ ...upload, fileName: "" },
		{ ...upload, fileSize: -1 },
		{ ...upload, fileSize: 26_214_401 },
		{ ...upload, fileSize: 1.5 },
		{ ...upload, fileType: "not a mime" },
		{ ...upload, filePath: "x".repeat(5000) },
		{ ...upload, bytes: "AAAA" },
		{ verb: "tools", tool: "x" },
		{ verb: "call", tool: "", args: {} },
		{ verb: "call", tool: "x" },
		{ verb: "call", tool: "x", args: [] },
		{ verb: "call", tool: "x", args: "{}" },
		{ verb: "call", tool: "x", args: { big: "y".repeat(20_000) } },
	])("rejects %p", (request) => {
		expect(() => validatePwExtRequest(request)).toThrow();
	});

	it("counts upload and call as write verbs and tools as a read verb", () => {
		expect(isPwExtWriteVerb("upload")).toBe(true);
		expect(isPwExtWriteVerb("call")).toBe(true);
		expect(isPwExtWriteVerb("tools")).toBe(false);
	});
});

describe("pw --ext cancel frames", () => {
	it("validates the CLI cancel and the extension cancel", () => {
		expect(
			validatePwExtCliCancel({ type: "cli-pw-ext-cancel", requestId: "r1" }),
		).toEqual({ type: "cli-pw-ext-cancel", requestId: "r1" });
		expect(() =>
			validatePwExtCliCancel({ type: "cli-pw-ext-cancel", requestId: "" }),
		).toThrow();
		expect(() =>
			validatePwExtCliCancel({ type: "cli-pw-ext-cancel", requestId: "r", x: 1 }),
		).toThrow();
		const frame = {
			type: "pw-ext-browser-cancel",
			sessionId: "s1",
			protocolVersion: CHAT_PROTOCOL_VERSION,
			requestId: "r1",
		};
		expect(validateChatFrame(frame)).toEqual(frame as never);
		expect(() => validateChatFrame({ ...frame, token: "t" })).toThrow();
		expect(() => validateChatFrame({ ...frame, extra: 1 })).toThrow();
	});
});

describe("pw --ext upload cap", () => {
	it("matches the daemon asset store cap", async () => {
		const { CHAT_MAX_ASSET_BYTES } = await import("../src/chat-format");
		const { PW_EXT_MAX_UPLOAD_BYTES } = await import("../src/pw-ext-format");
		expect(PW_EXT_MAX_UPLOAD_BYTES).toBe(CHAT_MAX_ASSET_BYTES);
	});
});
