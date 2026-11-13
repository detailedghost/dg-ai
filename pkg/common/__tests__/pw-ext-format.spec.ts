import { describe, expect, it } from "bun:test";
import { CHAT_PROTOCOL_VERSION, validateChatFrame, validatePageChatFrame } from "../src/index";
import {
	isPwExtCliResult,
	isPwExtSecretTooShort,
	PW_EXT_MAX_IMAGE_CHARS,
	PW_EXT_MAX_TEXT_CHARS,
	PW_EXT_MAX_TOOLS,
	PW_EXT_MAX_TIMEOUT_MS,
	PW_EXT_MIN_EXTENSION_VERSION,
	type PwExtCliRequest,
	validatePwExtCliRequest,
	validatePwExtRequest,
	validatePwExtResponse,
	validatePwExtCliCancel,
} from "../src/pw-ext-format";
import { PW_EXT_RELAY } from "../src/relay-features";

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
		{ verb: "count", target: "input[type=file]" },
		{ verb: "count", target: "e4", tabId: 3 },
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
		{ verb: "count" },
		{ verb: "count", target: "" },
		{ verb: "count", target: "#q", value: "x" },
	])("rejects %p", (request) => {
		expect(() => validatePwExtRequest(request)).toThrow();
	});
});

describe("validatePwExtResponse", () => {
	it("accepts text and a screenshot image", () => {
		const value = { text: "ok", image: "data:image/jpeg;base64,AAAA" };
		expect(validatePwExtResponse(value)).toEqual(value);
	});

	it("accepts a structured tools list", () => {
		const value = {
			text: "ok",
			tools: [{ name: "dg_outlook_list", description: "List mail", title: "List", inputSchema: "{}", annotations: "{}" }],
		};
		expect(validatePwExtResponse(value)).toEqual(value);
		expect(validatePwExtResponse({ text: "ok", tools: [{ name: "a", description: "b" }] })).toEqual({
			text: "ok",
			tools: [{ name: "a", description: "b" }],
		});
	});

	it("accepts 100 tools and rejects 101", () => {
		const tool = { name: "dg_outlook_list", description: "d" };
		expect(() => validatePwExtResponse({ text: "ok", tools: Array(100).fill(tool) })).not.toThrow();
		expect(() => validatePwExtResponse({ text: "ok", tools: Array(101).fill(tool) })).toThrow();
	});

	it.each([
		{ text: "ok", tools: "list" },
		{ text: "ok", tools: [null] },
		{ text: "ok", tools: [{ name: 1, description: "d" }] },
		{ text: "ok", tools: [{ name: "a", description: 2 }] },
		{ text: "ok", tools: [{ name: "a" }] },
		{ text: "ok", tools: [{ name: "a", description: "d", inputSchema: {} }] },
		{ text: "ok", tools: [{ name: "a", description: "d", title: 3 }] },
		{ text: "ok", tools: [{ name: "a", description: "d", annotations: false }] },
		{ text: "ok", tools: [{ name: "", description: "d" }] },
		{ text: "ok", tools: [{ name: "n".repeat(129), description: "d" }] },
		{ text: "ok", tools: [{ name: "a", description: "d", extra: "x" }] },
	])("rejects tools %p", (value) => {
		expect(() => validatePwExtResponse(value)).toThrow();
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

	it("validates every tool in the extension result on the full validator", () => {
		const ok = {
			...envelope,
			type: "pw-ext-browser-result",
			token: "t",
			ok: true,
			data: { text: "hi", tools: [{ name: "search", description: "d" }] },
		};
		expect(validateChatFrame(ok)).toEqual(ok as never);
		const withTools = (tools: unknown) => ({ ...ok, data: { text: "hi", tools } });
		expect(() => validateChatFrame(withTools([{ description: "d" }]))).toThrow();
		expect(() => validateChatFrame(withTools([{ name: "search", description: "d", extra: 1 }]))).toThrow();
		expect(() => validateChatFrame(withTools("search"))).toThrow();
		expect(() =>
			validateChatFrame(withTools(Array.from({ length: PW_EXT_MAX_TOOLS + 1 }, () => ({ name: "t", description: "d" })))),
		).toThrow();
	});

	it("rejects every pw-ext frame on the page validator", () => {
		const frames = [
			{ ...envelope, type: "pw-ext-browser-request", request: { verb: "click", target: "e1" }, timeoutMs: 1000 },
			{ ...envelope, type: "pw-ext-browser-cancel" },
			{ ...envelope, type: "pw-ext-browser-result", token: "t", ok: true, data: { text: "hi" } },
		];
		for (const frame of frames) {
			expect(validateChatFrame(frame)).toEqual(frame as never);
			expect(() => validatePageChatFrame(frame)).toThrow();
		}
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

describe("PW_EXT_RELAY table", () => {
	const minVersion = PW_EXT_MIN_EXTENSION_VERSION.join(".");
	const versionCheck = PW_EXT_RELAY.checks.find(
		(entry) => entry.check === "version",
	);
	const caps = PW_EXT_RELAY.checks.filter((entry) => entry.check === "cap");
	const peers = PW_EXT_RELAY.checks.find((entry) => entry.check === "peers");
	const active = PW_EXT_RELAY.checks.find((entry) => entry.check === "active");

	it("names its frames", () => {
		expect(PW_EXT_RELAY.name).toBe("pw-ext");
		expect(PW_EXT_RELAY.frames).toEqual({
			cliRequest: "cli-pw-ext-request",
			cliResult: "cli-pw-ext-result",
			cliCancel: "cli-pw-ext-cancel",
			browserRequest: "pw-ext-browser-request",
			browserResult: "pw-ext-browser-result",
			browserCancel: "pw-ext-browser-cancel",
		});
	});

	it("pins the caps and flags", () => {
		expect(PW_EXT_RELAY.caps).toEqual({
			pending: 16,
			perRequester: 2,
			sessionIds: 10_000,
		});
		expect(PW_EXT_RELAY.flags.failAllOnUnreadable).toBe(false);
		expect(PW_EXT_RELAY.rejected?.afterOversized).toBe("continue");
	});

	it("keeps the check order", () => {
		expect(PW_EXT_RELAY.checks.map((entry) => entry.check)).toEqual([
			"active",
			"replay",
			"cap",
			"cap",
			"peers",
			"burn",
			"version",
			"supports",
		]);
		expect(caps.map((entry) => (entry.check === "cap" ? entry.of : []))).toEqual(
			[["sessionIds"], ["requester", "pending"]],
		);
	});

	it("keeps the refusal strings", () => {
		expect(
			PW_EXT_RELAY.checks.map((entry) =>
				"refusal" in entry && typeof entry.refusal === "string" ? entry.refusal : undefined,
			),
		).toEqual([
			"pw --ext requires an active dg session.",
			"pw --ext requestId was already used on this session; send a new one.",
			"pw --ext request capacity reached; start a new session.",
			"pw --ext has too many pending requests; wait for the open requests to finish.",
			undefined,
			undefined,
			`pw --ext requires dg-ai-extension ${minVersion} or newer; update the extension, reload it, and reconnect this session.`,
			undefined,
		]);
		expect(peers?.check === "peers" && peers.multiple).toBe(
			"Multiple extension peers make the pw --ext request ambiguous; keep one extension connected to this session.",
		);
		expect(
			peers?.check === "peers" &&
				peers.none({
					sessionId: "s-1",
					cli: { type: "cli-pw-ext-request", requestId: "r", request: { verb: "current" } },
					timeoutMs: 1,
				}),
		).toBe(
			"No extension peer on session s-1. Pair the dg-ai-extension with this session, then retry. Run dg-skills doctor pw for the steps.",
		);
	});

	it("reuses the active refusal as strings.activeRequired", () => {
		expect(active?.check === "active" && active.refusal).toBe(
			PW_EXT_RELAY.strings.activeRequired,
		);
	});

	it.each([
		[minVersion, true],
		["1.99.0", true],
		[`${minVersion}+build.1`, true],
		["1.41.99", false],
		[undefined, false],
		["1.42", false],
	])("accepts extension version %p: %p", (version, expected) => {
		expect(
			versionCheck?.check === "version" && versionCheck.accepts(version),
		).toBe(expected);
	});

	it.each([
		[{}, "current", true],
		[{}, "count", false],
		[{ pwExtVerbs: ["current"] }, "count", false],
		[{ pwExtVerbs: ["current", "count"] }, "count", true],
	])("supports peer %p for verb %p: %p", (peer, verb, expected) => {
		const supports = PW_EXT_RELAY.checks.find((entry) => entry.check === "supports");
		const cli = { type: "cli-pw-ext-request" as const, requestId: "r", request: { verb: verb as never } };
		expect(supports?.check === "supports" && supports.accepts(peer, cli)).toBe(expected);
	});

	it("maps a CLI request to the browser request fields", () => {
		const cli = {
			type: "cli-pw-ext-request" as const,
			requestId: "r-1",
			request: { verb: "current" as const },
		};
		expect(PW_EXT_RELAY.timeoutMs(cli)).toBe(120_000);
		expect(PW_EXT_RELAY.timeoutMs({ ...cli, timeoutMs: 5 })).toBe(5);
		expect(PW_EXT_RELAY.toBrowserRequest(cli, 120_000)).toEqual({
			request: { verb: "current" },
			timeoutMs: 120_000,
		});
		expect(
			Object.keys(PW_EXT_RELAY.toBrowserRequest(cli, 120_000)),
		).toEqual(["request", "timeoutMs"]);
	});

	it("maps a browser request back to its request", () => {
		expect(
			PW_EXT_RELAY.fromBrowserRequest({
				requestId: "r-1",
				request: { verb: "click", target: "e4" },
				timeoutMs: 10,
			}),
		).toEqual({ verb: "click", target: "e4" });
	});

	it("maps a browser result to the CLI result fields", () => {
		expect(
			PW_EXT_RELAY.toCliResult({
				requestId: "r-1",
				ok: true,
				data: { text: "x" },
			}),
		).toEqual({ ok: true, data: { text: "x" } });
		expect(
			PW_EXT_RELAY.toCliResult({ requestId: "r-1", ok: false, error: "tab closed" }),
		).toEqual({ ok: false, error: "tab closed" });
	});

	it("words the lifecycle strings", () => {
		const { strings } = PW_EXT_RELAY;
		const cli = {
			type: "cli-pw-ext-request" as const,
			requestId: "r",
			request: { verb: "current" as const },
		};
		expect(strings.timeout({ sessionId: "s", cli, timeoutMs: 20 })).toBe(
			"pw --ext timed out after 20ms; the extension was told to cancel it.",
		);
		expect(strings.rejected?.("x".repeat(3000))).toHaveLength(2048);
		expect(strings.rejected?.("bad")).toBe(
			"pw --ext result could not be delivered: bad",
		);
		expect(strings.canceled).toBe("pw --ext request canceled.");
		expect(strings.extensionFailed).toBe(
			"pw --ext failed in the extension before it reported a result.",
		);
	});
});

describe("validatePwExtRequest tab verbs and tabId", () => {
	const TAB_ID_ERROR = "pw-ext request.tabId must be a non-negative integer";
	const MAX_TAB_ID = 2_147_483_647;

	it.each([
		{ verb: "snapshot", tabId: 7 },
		{ verb: "snapshot", tabId: 0 },
		{ verb: "snapshot", tabId: MAX_TAB_ID },
		{ verb: "click", target: "e4", tabId: 3 },
		{ verb: "fill", target: "e4", value: "v", tabId: 3 },
		{ verb: "open", url: "https://example.com/", tabId: 3 },
		{ verb: "screenshot", tabId: 3 },
		{ verb: "tabs" },
		{ verb: "new" },
		{ verb: "new", url: "https://example.com/a?b=1" },
		{ verb: "select", tabId: 12 },
		{ verb: "close" },
		{ verb: "close", tabId: 12 },
	])("accepts %p", (request) => {
		expect(validatePwExtRequest(request)).toEqual(request);
	});

	it.each([
		[{ verb: "snapshot", tabId: -1 }, TAB_ID_ERROR],
		[{ verb: "snapshot", tabId: 1.5 }, TAB_ID_ERROR],
		[{ verb: "snapshot", tabId: MAX_TAB_ID + 1 }, TAB_ID_ERROR],
		[{ verb: "snapshot", tabId: "7" }, TAB_ID_ERROR],
		[{ verb: "snapshot", tabId: Number.NaN }, TAB_ID_ERROR],
		[{ verb: "close", tabId: -1 }, TAB_ID_ERROR],
		[{ verb: "select" }, TAB_ID_ERROR],
		[{ verb: "tabs", tabId: 1 }, 'pw-ext request.tabId is not used by "tabs"'],
		[{ verb: "new", tabId: 1 }, 'pw-ext request.tabId is not used by "new"'],
		[
			{ verb: "new", url: "javascript:alert(1)" },
			"pw-ext request.url must be an http or https URL",
		],
		[
			{ verb: "new", url: "chrome://settings" },
			"pw-ext request.url must be an http or https URL",
		],
		[
			{ verb: "new", url: `https://example.com/${"a".repeat(2100)}` },
			"pw-ext request.url exceeds 2048 characters",
		],
		[{ verb: "new", url: "" }, "pw-ext request.url must be a non-empty string"],
		[{ verb: "tabs", surprise: true }, 'pw-ext request has unknown field "surprise"'],
		[{ verb: "close", url: "https://example.com/" }, 'pw-ext request has unknown field "url"'],
		[{ verb: "select", tabId: 1, url: "https://example.com/" }, 'pw-ext request has unknown field "url"'],
	])("rejects %p with %s", (request, message) => {
		expect(() => validatePwExtRequest(request)).toThrow(new TypeError(message));
	});

	it("accepts the tab verbs inside a CLI request", () => {
		const frame: PwExtCliRequest = {
			type: "cli-pw-ext-request",
			requestId: "r1",
			request: { verb: "select", tabId: 4 },
		};

		expect(validatePwExtCliRequest(frame)).toEqual(frame);
	});
});

describe("PW_EXT_MIN_EXTENSION_VERSION", () => {
	it("is at least the first release with per-agent tab groups", () => {
		const [major, minor, patch] = PW_EXT_MIN_EXTENSION_VERSION;
		const floor = major * 1_000_000 + minor * 1_000 + patch;

		expect(floor).toBeGreaterThanOrEqual(1_044_000);
	});
});

describe("pw --ext unmask and secret fill", () => {
	it.each([
		{ verb: "unmask", minutes: 15 },
		{ verb: "unmask", minutes: 1, tabId: 4 },
		{ verb: "unmask", minutes: 60 },
		{ verb: "unmask", off: true },
		{ verb: "fill", target: "#pw", value: "one-time", secret: true },
	])("accepts %o", (request) => {
		expect(validatePwExtRequest(request)).toEqual(request);
	});

	it.each([
		[{ verb: "unmask" }, "minutes"],
		[{ verb: "unmask", minutes: 0 }, "minutes"],
		[{ verb: "unmask", minutes: 61 }, "minutes"],
		[{ verb: "unmask", minutes: 1.5 }, "minutes"],
		[{ verb: "unmask", off: true, minutes: 5 }, "not used with off"],
		[{ verb: "unmask", off: false }, "off"],
		[{ verb: "fill", target: "#pw", value: "x", secret: false }, "secret"],
		[{ verb: "click", target: "#b", secret: true }, "unknown field"],
	])("rejects %o", (request, message) => {
		expect(() => validatePwExtRequest(request)).toThrow(message);
	});
});

describe("pw --ext dialog", () => {
	it.each([
		{ verb: "dialog" },
		{ verb: "dialog", tabId: 3 },
		{ verb: "dialog", answer: "dismiss" },
		{ verb: "dialog", answer: "accept" },
		{ verb: "dialog", answer: "accept", text: "Ada" },
		{ verb: "dialog", answer: "accept", text: "" },
	])("accepts %o", (request) => {
		expect(validatePwExtRequest(request)).toEqual(request);
	});

	it.each([
		[{ verb: "dialog", answer: "maybe" }, "answer"],
		[{ verb: "dialog", answer: "dismiss", text: "x" }, "text"],
		[{ verb: "dialog", text: "x" }, "text"],
		[{ verb: "dialog", answer: "accept", text: 3 }, "text"],
		[{ verb: "dialog", answer: "accept", text: "x".repeat(4097) }, "text"],
		[{ verb: "click", target: "#b", answer: "accept" }, "unknown field"],
	])("rejects %o", (request, message) => {
		expect(() => validatePwExtRequest(request)).toThrow(message);
	});
});

describe("pw --ext network", () => {
	it.each([
		{ verb: "network" },
		{ verb: "network", tabId: 3 },
		{ verb: "network", filter: "service.svc", limit: 200, since: 0 },
		{ verb: "network", since: 1_731_500_000_000, values: true },
		{ verb: "network", since: "clear" },
	])("accepts %o", (request) => {
		expect(validatePwExtRequest(request)).toEqual(request);
	});

	it.each([
		[{ verb: "network", filter: "" }, "filter"],
		[{ verb: "network", filter: "x".repeat(201) }, "filter"],
		[{ verb: "network", limit: 0 }, "limit"],
		[{ verb: "network", limit: 201 }, "limit"],
		[{ verb: "network", limit: 1.5 }, "limit"],
		[{ verb: "network", since: -1 }, "since"],
		[{ verb: "network", since: "later" }, "since"],
		[{ verb: "network", values: false }, "values"],
		[{ verb: "network", since: "clear", values: true }, "since clear"],
		[{ verb: "network", since: "clear", filter: "x" }, "since clear"],
		[{ verb: "snapshot", values: true }, "unknown field"],
	])("rejects %o", (request, message) => {
		expect(() => validatePwExtRequest(request)).toThrow(message);
	});
});

describe("isPwExtSecretTooShort", () => {
	it.each([
		["", true],
		["x", true],
		["abc", true],
		["a   \t\n", true],
		["   \t", true],
		["abcd", false],
		["ab cd", false],
		["Temp-Pass-123", false],
	])("%p is too short: %p", (value, short) => {
		expect(isPwExtSecretTooShort(value)).toBe(short);
	});
});

describe("isPwExtCliResult", () => {
	const frame = { type: "cli-pw-ext-result", requestId: "r", ok: true };

	it("accepts a result frame with the same requestId", () => {
		expect(isPwExtCliResult("r")(frame)).toBe(true);
	});

	it("rejects a result frame with another requestId", () => {
		expect(isPwExtCliResult("other")(frame)).toBe(false);
	});

	it.each([null, "text", 4, { type: "cli-recv-result", requestId: "r" }])(
		"rejects %p",
		(value) => {
			expect(isPwExtCliResult("r")(value)).toBe(false);
		},
	);
});
