import { describe, expect, it } from "bun:test";
import {
	CHAT_MAX_PAYLOAD_BYTES,
	INBOX_MAX_TIMEOUT_MS,
	PROTO_MAX_TIMEOUT_MS,
	PW_EXT_MAX_TIMEOUT_MS,
	validateChatFrame,
	validateInboxCliRequest,
	validateProtoCliRequest,
	validatePwExtCliCancel,
	validatePwExtCliRequest,
} from "../src/index";

const FRAME_TYPES = [
	"inbox-browser-request",
	"inbox-browser-result",
	"proto-browser-request",
	"proto-browser-result",
	"proto-browser-progress",
	"pw-ext-browser-request",
	"pw-ext-browser-cancel",
	"pw-ext-browser-result",
	"cli-inbox-request",
	"cli-proto-request",
	"cli-pw-ext-request",
	"cli-pw-ext-cancel",
] as const;

const OVERSIZE_UNREACHABLE = [
	"inbox-browser-result",
	"proto-browser-request",
	"proto-browser-progress",
	"pw-ext-browser-request",
	"pw-ext-browser-cancel",
] as const;

type GoldenType = (typeof FRAME_TYPES)[number];
type Frame = Readonly<Record<string, unknown>>;
type GoldenRow = {
	readonly type: GoldenType;
	readonly axis: string;
	readonly frame: unknown;
	readonly expect: string;
};

const SESSION_ID = "session-1";
const REQUEST_ID = "request-1";
const OUTBOUND = { sessionId: SESSION_ID, protocolVersion: 1, requestId: REQUEST_ID };
const INBOUND = { ...OUTBOUND, token: "token-1" };

const BASES = {
	"inbox-browser-request": {
		type: "inbox-browser-request",
		...OUTBOUND,
		request: { operation: "list-folders" },
	},
	"inbox-browser-result": {
		type: "inbox-browser-result",
		...INBOUND,
		ok: true,
		data: { hasMore: false },
	},
	"proto-browser-request": {
		type: "proto-browser-request",
		...OUTBOUND,
		phase: "scrape",
		slug: "demo",
		markedUrl: "https://example.com/page",
	},
	"proto-browser-result": {
		type: "proto-browser-result",
		...INBOUND,
		ok: true,
		data: {
			kind: "verdict",
			verdict: { slug: "demo", selectedKey: "a", ts: 1, action: "approve" },
		},
	},
	"proto-browser-progress": {
		type: "proto-browser-progress",
		...INBOUND,
		status: "scraping",
	},
	"pw-ext-browser-request": {
		type: "pw-ext-browser-request",
		...OUTBOUND,
		request: { verb: "current" },
		timeoutMs: 1000,
	},
	"pw-ext-browser-cancel": { type: "pw-ext-browser-cancel", ...OUTBOUND },
	"pw-ext-browser-result": {
		type: "pw-ext-browser-result",
		...INBOUND,
		ok: true,
		data: { text: "page text" },
	},
	"cli-inbox-request": {
		type: "cli-inbox-request",
		requestId: REQUEST_ID,
		operation: "browser",
		request: { operation: "list-folders" },
	},
	"cli-proto-request": {
		type: "cli-proto-request",
		requestId: REQUEST_ID,
		phase: "scrape",
		slug: "demo",
		markedUrl: "https://example.com/page",
	},
	"cli-pw-ext-request": {
		type: "cli-pw-ext-request",
		requestId: REQUEST_ID,
		request: { verb: "current" },
	},
	"cli-pw-ext-cancel": { type: "cli-pw-ext-cancel", requestId: REQUEST_ID },
} as const satisfies Record<GoldenType, Frame>;

const VALIDATORS = {
	"inbox-browser-request": validateChatFrame,
	"inbox-browser-result": validateChatFrame,
	"proto-browser-request": validateChatFrame,
	"proto-browser-result": validateChatFrame,
	"proto-browser-progress": validateChatFrame,
	"pw-ext-browser-request": validateChatFrame,
	"pw-ext-browser-cancel": validateChatFrame,
	"pw-ext-browser-result": validateChatFrame,
	"cli-inbox-request": validateInboxCliRequest,
	"cli-proto-request": validateProtoCliRequest,
	"cli-pw-ext-request": validatePwExtCliRequest,
	"cli-pw-ext-cancel": validatePwExtCliCancel,
} as const satisfies Record<GoldenType, (value: unknown) => unknown>;

function rowsFor(
	type: GoldenType,
	build: (fixture: {
		with: (fields: Frame) => Frame;
		without: (key: string) => Frame;
		ok: (axis: string, frame?: Frame) => GoldenRow;
		err: (axis: string, frame: Frame, expect: string) => GoldenRow;
	}) => readonly GoldenRow[],
): readonly GoldenRow[] {
	const base: Frame = BASES[type];
	return build({
		with: (fields) => ({ ...base, ...fields }),
		without: (key) =>
			Object.fromEntries(Object.entries(base).filter(([name]) => name !== key)),
		ok: (axis, frame = base) => ({ type, axis, frame, expect: "ok" }),
		err: (axis, frame, expect) => ({ type, axis, frame, expect }),
	});
}

type Fixture = Parameters<Parameters<typeof rowsFor>[1]>[0];

const TAB_ID_ERROR = "pw-ext request.tabId must be a non-negative integer";

function tabRequestRows(t: Fixture): readonly GoldenRow[] {
	const withRequest = (request: unknown) => t.with({ request });
	return [
		t.ok("request verb tabs", withRequest({ verb: "tabs" })),
		t.ok("request verb new", withRequest({ verb: "new" })),
		t.ok("request verb new with url", withRequest({ verb: "new", url: "https://example.com/" })),
		t.ok("request verb select", withRequest({ verb: "select", tabId: 4 })),
		t.ok("request verb close", withRequest({ verb: "close" })),
		t.ok("request tabId on snapshot", withRequest({ verb: "snapshot", tabId: 7 })),
		t.err("request tabId -1", withRequest({ verb: "snapshot", tabId: -1 }), TAB_ID_ERROR),
		t.err("request tabId 1.5", withRequest({ verb: "snapshot", tabId: 1.5 }), TAB_ID_ERROR),
		t.err("request tabId 2147483648", withRequest({ verb: "snapshot", tabId: 2_147_483_648 }), TAB_ID_ERROR),
		t.err("request tabId string", withRequest({ verb: "snapshot", tabId: "7" }), TAB_ID_ERROR),
		t.err("request select without tabId", withRequest({ verb: "select" }), TAB_ID_ERROR),
		t.err("request new javascript url", withRequest({ verb: "new", url: "javascript:alert(1)" }), "pw-ext request.url must be an http or https URL"),
		t.err("request tabId on tabs", withRequest({ verb: "tabs", tabId: 1 }), 'pw-ext request.tabId is not used by "tabs"'),
	];
}

const inboxRequestRows = rowsFor("inbox-browser-request", (t) => [
	t.ok("ok"),
	t.err("requestId missing", t.without("requestId"), "chat frame.requestId must be a non-empty string"),
	t.err("requestId empty", t.with({ requestId: "" }), "chat frame.requestId must be a non-empty string"),
	t.err("requestId whitespace-only", t.with({ requestId: "   " }), "chat frame.requestId must be a non-empty string"),
	t.err("requestId lone surrogate", t.with({ requestId: "\ud800" }), "chat frame.requestId must be a non-empty string"),
	t.ok("requestId 128 characters", t.with({ requestId: "x".repeat(128) })),
	t.err("requestId 129 characters", t.with({ requestId: "x".repeat(129) }), "inbox requestId exceeds 128 characters"),
	t.err("request not an object", t.with({ request: "list-folders" }), "inbox browser request must be an object"),
	t.ok("extra top-level key accepted", t.with({ extra: 1 })),
	t.err("envelope sessionId missing", t.without("sessionId"), "chat frame.sessionId must be a non-empty string"),
	t.err("envelope sessionId empty", t.with({ sessionId: "" }), "chat frame.sessionId must be a non-empty string"),
	t.err("envelope protocolVersion missing", t.without("protocolVersion"), "chat frame.protocolVersion must be a finite number"),
	t.err("envelope protocolVersion non-numeric", t.with({ protocolVersion: "1" }), "chat frame.protocolVersion must be a finite number"),
	t.err("envelope token present", t.with({ token: "token-1" }), "chat frame.token must not be present on outbound \"inbox-browser-request\" frames"),
	t.err("oversize", t.with({ request: { operation: "mark-read", messageIds: Array.from({ length: 200 }, () => "\u0001".repeat(1024)) } }), "chat frame exceeds CHAT_MAX_PAYLOAD_BYTES (1048576)"),
	t.err("precedence envelope before body", t.with({ sessionId: "", requestId: "" }), "chat frame.sessionId must be a non-empty string"),
]);

const inboxResultRows = rowsFor("inbox-browser-result", (t) => [
	t.ok("ok"),
	t.ok("ok failed result with error", t.with({ ok: false, data: undefined, error: "boom" })),
	t.err("requestId missing", t.without("requestId"), "chat frame.requestId must be a non-empty string"),
	t.err("requestId empty", t.with({ requestId: "" }), "chat frame.requestId must be a non-empty string"),
	t.err("requestId whitespace-only", t.with({ requestId: "   " }), "chat frame.requestId must be a non-empty string"),
	t.err("requestId lone surrogate", t.with({ requestId: "\ud800" }), "chat frame.requestId must be a non-empty string"),
	t.ok("requestId 128 characters", t.with({ requestId: "x".repeat(128) })),
	t.err("requestId 129 characters", t.with({ requestId: "x".repeat(129) }), "inbox requestId exceeds 128 characters"),
	t.err("ok not a boolean", t.with({ ok: "yes" }), "inbox result.ok must be a boolean"),
	t.err("ok missing", t.without("ok"), "inbox result.ok must be a boolean"),
	t.err("successful result with error", t.with({ error: "boom" }), "successful inbox result must not contain an error"),
	t.err("failed result with data", t.with({ ok: false, error: "boom" }), "failed inbox result must not contain data"),
	t.err("failed result with empty error", t.with({ ok: false, data: undefined, error: "" }), "inbox result.error must be a non-empty string"),
	t.err("failed result with missing error", t.with({ ok: false, data: undefined }), "inbox result.error must be a non-empty string"),
	t.err("error of 2049 characters", t.with({ ok: false, data: undefined, error: "x".repeat(2049) }), "inbox result.error exceeds 2048 characters"),
	t.ok("error of 2048 characters", t.with({ ok: false, data: undefined, error: "x".repeat(2048) })),
	t.err("data not an object", t.with({ data: "folders" }), "inbox browser response must be an object"),
	t.err("extra top-level key", t.with({ extra: 1 }), "unknown inbox result field"),
	t.err("envelope sessionId missing", t.without("sessionId"), "chat frame.sessionId must be a non-empty string"),
	t.err("envelope sessionId empty", t.with({ sessionId: "" }), "chat frame.sessionId must be a non-empty string"),
	t.err("envelope protocolVersion missing", t.without("protocolVersion"), "chat frame.protocolVersion must be a finite number"),
	t.err("envelope protocolVersion non-numeric", t.with({ protocolVersion: "1" }), "chat frame.protocolVersion must be a finite number"),
	t.err("envelope token missing", t.without("token"), "chat frame.token must be a non-empty string"),
	t.err("envelope token empty", t.with({ token: "" }), "chat frame.token must be a non-empty string"),
	t.err("precedence requestId before ok", t.with({ requestId: "", ok: "yes" }), "chat frame.requestId must be a non-empty string"),
	t.err("precedence ok type before cross-check", t.with({ ok: "yes", error: "boom" }), "inbox result.ok must be a boolean"),
]);

const protoRequestRows = rowsFor("proto-browser-request", (t) => [
	t.ok("ok"),
	t.err("requestId missing", t.without("requestId"), "chat frame.requestId must be a non-empty string"),
	t.err("requestId empty", t.with({ requestId: "" }), "chat frame.requestId must be a non-empty string"),
	t.err("requestId whitespace-only", t.with({ requestId: "   " }), "chat frame.requestId must be a non-empty string"),
	t.err("requestId lone surrogate", t.with({ requestId: "\ud800" }), "chat frame.requestId must be a non-empty string"),
	t.ok("requestId 128 characters", t.with({ requestId: "x".repeat(128) })),
	t.err("requestId 129 characters", t.with({ requestId: "x".repeat(129) }), "proto requestId exceeds 128 characters"),
	t.err("phase invalid", t.with({ phase: "launch" }), "chat frame.phase must be \"scrape\" or \"plant\""),
	t.err("phase missing", t.without("phase"), "chat frame.phase must be \"scrape\" or \"plant\""),
	t.err("slug invalid", t.with({ slug: "../escape" }), "chat frame.slug must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$ (1-128 letters, digits, underscores, or hyphens; starts alphanumeric)"),
	t.err("slug missing", t.without("slug"), "chat frame.slug must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$ (1-128 letters, digits, underscores, or hyphens; starts alphanumeric)"),
	t.err("markedUrl missing", t.without("markedUrl"), "chat frame.markedUrl must be a non-empty string"),
	t.err("markedUrl not http", t.with({ markedUrl: "ftp://example.com/page" }), "chat frame.markedUrl must be an http(s) URL"),
	t.err("markedUrl unparsable", t.with({ markedUrl: "not a url" }), "chat frame.markedUrl must be an http(s) URL"),
	t.err("markedUrl over the marker limit", t.with({ markedUrl: `https://example.com/${"x".repeat(33_000)}` }), "chat frame.markedUrl exceeds the marker URL limit"),
	t.err("timeoutMs not a number", t.with({ timeoutMs: "1000" }), "chat frame.timeoutMs must be a finite number"),
	t.err("timeoutMs NaN", t.with({ timeoutMs: Number.NaN }), "chat frame.timeoutMs must be a finite number"),
	t.err("timeoutMs 0", t.with({ timeoutMs: 0 }), "chat frame.timeoutMs must be between 1 and 900000"),
	t.err("timeoutMs PROTO_MAX_TIMEOUT_MS plus 1", t.with({ timeoutMs: PROTO_MAX_TIMEOUT_MS + 1 }), "chat frame.timeoutMs must be between 1 and 900000"),
	t.ok("timeoutMs PROTO_MAX_TIMEOUT_MS", t.with({ timeoutMs: PROTO_MAX_TIMEOUT_MS })),
	t.ok("timeoutMs omitted"),
	t.ok("extra top-level key accepted", t.with({ extra: 1 })),
	t.err("envelope sessionId missing", t.without("sessionId"), "chat frame.sessionId must be a non-empty string"),
	t.err("envelope sessionId empty", t.with({ sessionId: "" }), "chat frame.sessionId must be a non-empty string"),
	t.err("envelope protocolVersion missing", t.without("protocolVersion"), "chat frame.protocolVersion must be a finite number"),
	t.err("envelope protocolVersion non-numeric", t.with({ protocolVersion: "1" }), "chat frame.protocolVersion must be a finite number"),
	t.err("envelope token present", t.with({ token: "token-1" }), "chat frame.token must not be present on outbound \"proto-browser-request\" frames"),
	t.err("precedence requestId before phase", t.with({ requestId: "", phase: "launch" }), "chat frame.requestId must be a non-empty string"),
]);

const protoResultRows = rowsFor("proto-browser-result", (t) => [
	t.ok("ok"),
	t.ok("ok failed result with error", t.with({ ok: false, data: undefined, error: "boom" })),
	t.ok("ok failed result with notReady", t.with({ ok: false, data: undefined, notReady: { code: "login-page", message: "sign in", landedUrl: "https://example.com/login" } })),
	t.err("requestId missing", t.without("requestId"), "chat frame.requestId must be a non-empty string"),
	t.err("requestId empty", t.with({ requestId: "" }), "chat frame.requestId must be a non-empty string"),
	t.err("requestId whitespace-only", t.with({ requestId: "   " }), "chat frame.requestId must be a non-empty string"),
	t.err("requestId lone surrogate", t.with({ requestId: "\ud800" }), "chat frame.requestId must be a non-empty string"),
	t.ok("requestId 128 characters", t.with({ requestId: "x".repeat(128) })),
	t.err("requestId 129 characters", t.with({ requestId: "x".repeat(129) }), "proto requestId exceeds 128 characters"),
	t.err("ok not a boolean", t.with({ ok: "yes" }), "proto result.ok must be a boolean"),
	t.err("ok missing", t.without("ok"), "proto result.ok must be a boolean"),
	t.err("successful result with error", t.with({ error: "boom" }), "successful proto result must not contain an error or notReady"),
	t.err("successful result with notReady", t.with({ notReady: { code: "login-page", message: "sign in", landedUrl: "https://example.com/login" } }), "successful proto result must not contain an error or notReady"),
	t.err("failed result with data", t.with({ ok: false, error: "boom" }), "failed proto result must not contain data"),
	t.err("failed result with both error and notReady", t.with({ ok: false, data: undefined, error: "boom", notReady: { code: "login-page", message: "sign in", landedUrl: "https://example.com/login" } }), "failed proto result must contain exactly one of error or notReady"),
	t.err("failed result with neither error nor notReady", t.with({ ok: false, data: undefined }), "failed proto result must contain exactly one of error or notReady"),
	t.err("failed result with empty error", t.with({ ok: false, data: undefined, error: "" }), "proto result.error must be a non-empty string"),
	t.err("error of 2049 characters", t.with({ ok: false, data: undefined, error: "x".repeat(2049) }), "proto result.error exceeds 2048 characters"),
	t.ok("error of 2048 characters", t.with({ ok: false, data: undefined, error: "x".repeat(2048) })),
	t.err("data not an object", t.with({ data: "verdict" }), "proto browser data must be an object"),
	t.err("notReady not an object", t.with({ ok: false, data: undefined, notReady: "login-page" }), "proto not-ready error must be an object"),
	t.err("extra top-level key", t.with({ extra: 1 }), "unknown proto result field"),
	t.err("envelope sessionId missing", t.without("sessionId"), "chat frame.sessionId must be a non-empty string"),
	t.err("envelope sessionId empty", t.with({ sessionId: "" }), "chat frame.sessionId must be a non-empty string"),
	t.err("envelope protocolVersion missing", t.without("protocolVersion"), "chat frame.protocolVersion must be a finite number"),
	t.err("envelope protocolVersion non-numeric", t.with({ protocolVersion: "1" }), "chat frame.protocolVersion must be a finite number"),
	t.err("envelope token missing", t.without("token"), "chat frame.token must be a non-empty string"),
	t.err("envelope token empty", t.with({ token: "" }), "chat frame.token must be a non-empty string"),
	t.err("oversize", t.with({ data: { kind: "verdict", verdict: { slug: "demo", selectedKey: "a", ts: 1, action: "approve", notes: "x".repeat(CHAT_MAX_PAYLOAD_BYTES) } } }), "chat frame exceeds CHAT_MAX_PAYLOAD_BYTES (1048576)"),
	t.err("precedence requestId before ok", t.with({ requestId: "", ok: "yes" }), "chat frame.requestId must be a non-empty string"),
	t.err("precedence both-or-neither before error content", t.with({ ok: false, data: undefined, error: "", notReady: { code: "login-page", message: "sign in", landedUrl: "https://example.com/login" } }), "failed proto result must contain exactly one of error or notReady"),
]);

const protoProgressRows = rowsFor("proto-browser-progress", (t) => [
	t.ok("ok"),
	t.err("requestId missing", t.without("requestId"), "chat frame.requestId must be a non-empty string"),
	t.err("requestId empty", t.with({ requestId: "" }), "chat frame.requestId must be a non-empty string"),
	t.err("requestId whitespace-only", t.with({ requestId: "   " }), "chat frame.requestId must be a non-empty string"),
	t.err("requestId lone surrogate", t.with({ requestId: "\ud800" }), "chat frame.requestId must be a non-empty string"),
	t.ok("requestId 128 characters", t.with({ requestId: "x".repeat(128) })),
	t.err("requestId 129 characters", t.with({ requestId: "x".repeat(129) }), "proto requestId exceeds 128 characters"),
	t.err("status missing", t.without("status"), "chat frame.status must be a non-empty string"),
	t.err("status empty", t.with({ status: "" }), "chat frame.status must be a non-empty string"),
	t.err("status of 513 characters", t.with({ status: "x".repeat(513) }), "proto progress status exceeds 512 characters"),
	t.ok("status of 512 characters", t.with({ status: "x".repeat(512) })),
	t.ok("extra top-level key accepted", t.with({ extra: 1 })),
	t.err("envelope sessionId missing", t.without("sessionId"), "chat frame.sessionId must be a non-empty string"),
	t.err("envelope sessionId empty", t.with({ sessionId: "" }), "chat frame.sessionId must be a non-empty string"),
	t.err("envelope protocolVersion missing", t.without("protocolVersion"), "chat frame.protocolVersion must be a finite number"),
	t.err("envelope protocolVersion non-numeric", t.with({ protocolVersion: "1" }), "chat frame.protocolVersion must be a finite number"),
	t.err("envelope token missing", t.without("token"), "chat frame.token must be a non-empty string"),
	t.err("envelope token empty", t.with({ token: "" }), "chat frame.token must be a non-empty string"),
]);

const pwExtRequestRows = rowsFor("pw-ext-browser-request", (t) => [
	t.ok("ok"),
	t.err("requestId missing", t.without("requestId"), "chat frame.requestId must be a non-empty string"),
	t.err("requestId empty", t.with({ requestId: "" }), "chat frame.requestId must be a non-empty string"),
	t.err("requestId whitespace-only", t.with({ requestId: "   " }), "chat frame.requestId must be a non-empty string"),
	t.err("requestId lone surrogate", t.with({ requestId: "\ud800" }), "chat frame.requestId must be a non-empty string"),
	t.ok("requestId 128 characters", t.with({ requestId: "x".repeat(128) })),
	t.err("requestId 129 characters", t.with({ requestId: "x".repeat(129) }), "chat frame.requestId exceeds 128 characters"),
	t.err("request not an object", t.with({ request: "current" }), "pw-ext request must be an object"),
	t.err("request verb unsupported", t.with({ request: { verb: "eval" } }), "pw-ext request.verb is not a supported verb"),
	...tabRequestRows(t),
	t.err("timeoutMs missing", t.without("timeoutMs"), "chat frame.timeoutMs must be an integer between 1 and 300000"),
	t.err("timeoutMs 1.5", t.with({ timeoutMs: 1.5 }), "chat frame.timeoutMs must be an integer between 1 and 300000"),
	t.err("timeoutMs 0", t.with({ timeoutMs: 0 }), "chat frame.timeoutMs must be an integer between 1 and 300000"),
	t.err("timeoutMs PW_EXT_MAX_TIMEOUT_MS plus 1", t.with({ timeoutMs: PW_EXT_MAX_TIMEOUT_MS + 1 }), "chat frame.timeoutMs must be an integer between 1 and 300000"),
	t.ok("timeoutMs PW_EXT_MAX_TIMEOUT_MS", t.with({ timeoutMs: PW_EXT_MAX_TIMEOUT_MS })),
	t.err("extra top-level key", t.with({ extra: 1 }), "chat frame has unknown field \"extra\""),
	t.err("envelope sessionId missing", t.without("sessionId"), "chat frame.sessionId must be a non-empty string"),
	t.err("envelope sessionId empty", t.with({ sessionId: "" }), "chat frame.sessionId must be a non-empty string"),
	t.err("envelope protocolVersion missing", t.without("protocolVersion"), "chat frame.protocolVersion must be a finite number"),
	t.err("envelope protocolVersion non-numeric", t.with({ protocolVersion: "1" }), "chat frame.protocolVersion must be a finite number"),
	t.err("envelope token present", t.with({ token: "token-1" }), "chat frame.token must not be present on outbound \"pw-ext-browser-request\" frames"),
	t.err("precedence requestId before request", t.with({ requestId: "", request: "current" }), "chat frame.requestId must be a non-empty string"),
	t.err("precedence request before timeoutMs", t.with({ request: "current", timeoutMs: 0 }), "pw-ext request must be an object"),
]);

const pwExtCancelRows = rowsFor("pw-ext-browser-cancel", (t) => [
	t.ok("ok"),
	t.err("requestId missing", t.without("requestId"), "chat frame.requestId must be a non-empty string"),
	t.err("requestId empty", t.with({ requestId: "" }), "chat frame.requestId must be a non-empty string"),
	t.err("requestId whitespace-only", t.with({ requestId: "   " }), "chat frame.requestId must be a non-empty string"),
	t.err("requestId lone surrogate", t.with({ requestId: "\ud800" }), "chat frame.requestId must be a non-empty string"),
	t.ok("requestId 128 characters", t.with({ requestId: "x".repeat(128) })),
	t.err("requestId 129 characters", t.with({ requestId: "x".repeat(129) }), "chat frame.requestId exceeds 128 characters"),
	t.err("extra top-level key", t.with({ extra: 1 }), "chat frame has unknown field \"extra\""),
	t.err("envelope sessionId missing", t.without("sessionId"), "chat frame.sessionId must be a non-empty string"),
	t.err("envelope sessionId empty", t.with({ sessionId: "" }), "chat frame.sessionId must be a non-empty string"),
	t.err("envelope protocolVersion missing", t.without("protocolVersion"), "chat frame.protocolVersion must be a finite number"),
	t.err("envelope protocolVersion non-numeric", t.with({ protocolVersion: "1" }), "chat frame.protocolVersion must be a finite number"),
	t.err("envelope token present", t.with({ token: "token-1" }), "chat frame.token must not be present on outbound \"pw-ext-browser-cancel\" frames"),
]);

const pwExtResultRows = rowsFor("pw-ext-browser-result", (t) => [
	t.ok("ok"),
	t.ok("ok failed result with error", t.with({ ok: false, data: undefined, error: "boom" })),
	t.err("requestId missing", t.without("requestId"), "chat frame.requestId must be a non-empty string"),
	t.err("requestId empty", t.with({ requestId: "" }), "chat frame.requestId must be a non-empty string"),
	t.err("requestId whitespace-only", t.with({ requestId: "   " }), "chat frame.requestId must be a non-empty string"),
	t.err("requestId lone surrogate", t.with({ requestId: "\ud800" }), "chat frame.requestId must be a non-empty string"),
	t.ok("requestId 128 characters", t.with({ requestId: "x".repeat(128) })),
	t.err("requestId 129 characters", t.with({ requestId: "x".repeat(129) }), "chat frame.requestId exceeds 128 characters"),
	t.err("ok not a boolean", t.with({ ok: "yes" }), "chat frame.ok must be a boolean"),
	t.err("ok missing", t.without("ok"), "chat frame.ok must be a boolean"),
	t.err("successful result with error", t.with({ error: "boom" }), "successful chat frame must not contain an error"),
	t.err("failed result with data", t.with({ ok: false, error: "boom" }), "failed chat frame must not contain data"),
	t.err("failed result with empty error", t.with({ ok: false, data: undefined, error: "" }), "chat frame.error must be a non-empty string"),
	t.err("failed result with missing error", t.with({ ok: false, data: undefined }), "chat frame.error must be a non-empty string"),
	t.err("error of 2049 characters", t.with({ ok: false, data: undefined, error: "x".repeat(2049) }), "chat frame.error exceeds 2048 characters"),
	t.ok("error of 2048 characters", t.with({ ok: false, data: undefined, error: "x".repeat(2048) })),
	t.err("data not an object", t.with({ data: "text" }), "pw-ext response must be an object"),
	t.err("extra top-level key", t.with({ extra: 1 }), "chat frame has unknown field \"extra\""),
	t.err("envelope sessionId missing", t.without("sessionId"), "chat frame.sessionId must be a non-empty string"),
	t.err("envelope sessionId empty", t.with({ sessionId: "" }), "chat frame.sessionId must be a non-empty string"),
	t.err("envelope protocolVersion missing", t.without("protocolVersion"), "chat frame.protocolVersion must be a finite number"),
	t.err("envelope protocolVersion non-numeric", t.with({ protocolVersion: "1" }), "chat frame.protocolVersion must be a finite number"),
	t.err("envelope token missing", t.without("token"), "chat frame.token must be a non-empty string"),
	t.err("envelope token empty", t.with({ token: "" }), "chat frame.token must be a non-empty string"),
	t.err("oversize", t.with({ data: { text: "\u0001".repeat(100_000), image: `data:image/png;base64,${"A".repeat(599_978)}` } }), "chat frame exceeds CHAT_MAX_PAYLOAD_BYTES (1048576)"),
	t.err("precedence requestId before ok", t.with({ requestId: "", ok: "yes" }), "chat frame.requestId must be a non-empty string"),
	t.err("precedence cross-check before unknown field", t.with({ ok: false, error: "boom", extra: 1 }), "failed chat frame must not contain data"),
]);

const cliInboxRows = rowsFor("cli-inbox-request", (t) => [
	t.ok("ok operation browser"),
	t.ok("ok operation profile-get", { type: "cli-inbox-request", requestId: "request-1", operation: "profile-get", name: "work" }),
	t.ok("ok operation profile-set", { type: "cli-inbox-request", requestId: "request-1", operation: "profile-set", name: "work", profile: { provider: "protonmail" } }),
	t.ok("ok operation profile-list", { type: "cli-inbox-request", requestId: "request-1", operation: "profile-list" }),
	t.ok("ok operation cache-get", { type: "cli-inbox-request", requestId: "request-1", operation: "cache-get", name: "work", provider: "gmail" }),
	t.ok("ok operation cache-set", { type: "cli-inbox-request", requestId: "request-1", operation: "cache-set", name: "work", provider: "gmail", cache: "{}" }),
	t.err("type mismatch", t.with({ type: "cli-inbox-result" }), "inbox CLI request.type must be one of cli-inbox-request"),
	t.err("operation not in set", t.with({ operation: "nope" }), "inbox CLI request.operation must be one of profile-get, profile-set, profile-list, cache-get, cache-set, browser"),
	t.err("operation missing", t.without("operation"), "inbox CLI request.operation must be one of profile-get, profile-set, profile-list, cache-get, cache-set, browser"),
	t.err("unknown field on profile-get", { type: "cli-inbox-request", requestId: "request-1", operation: "profile-get", name: "work", extra: 1 }, "inbox CLI request.extra is not supported"),
	t.err("unknown field on profile-set", { type: "cli-inbox-request", requestId: "request-1", operation: "profile-set", name: "work", profile: { provider: "protonmail" }, extra: 1 }, "inbox CLI request.extra is not supported"),
	t.err("unknown field on profile-list", { type: "cli-inbox-request", requestId: "request-1", operation: "profile-list", extra: 1 }, "inbox CLI request.extra is not supported"),
	t.err("unknown field on cache-get", { type: "cli-inbox-request", requestId: "request-1", operation: "cache-get", name: "work", provider: "gmail", extra: 1 }, "inbox CLI request.extra is not supported"),
	t.err("unknown field on cache-set", { type: "cli-inbox-request", requestId: "request-1", operation: "cache-set", name: "work", provider: "gmail", cache: "{}", extra: 1 }, "inbox CLI request.extra is not supported"),
	t.err("extra top-level key", t.with({ extra: 1 }), "inbox CLI request.extra is not supported"),
	t.err("unknown field request on profile-get", { type: "cli-inbox-request", requestId: "request-1", operation: "profile-get", name: "work", request: { operation: "list-folders" } }, "inbox CLI request.request is not supported"),
	t.err("unknown field name on browser", t.with({ name: "work" }), "inbox CLI request.name is not supported"),
	t.ok("extra top-level key ignored when undefined", t.with({ extra: undefined })),
	t.err("requestId missing", t.without("requestId"), "inbox CLI request.requestId must be a non-empty string of at most 128 bytes"),
	t.err("requestId empty", t.with({ requestId: "" }), "inbox CLI request.requestId must be a non-empty string of at most 128 bytes"),
	t.err("requestId whitespace-only", t.with({ requestId: "   " }), "inbox CLI request.requestId must be a non-empty string of at most 128 bytes"),
	t.ok("requestId lone surrogate", t.with({ requestId: "\ud800" })),
	t.ok("requestId 128 characters", t.with({ requestId: "x".repeat(128) })),
	t.err("requestId 129 characters", t.with({ requestId: "x".repeat(129) }), "inbox CLI request.requestId must be a non-empty string of at most 128 bytes"),
	t.err("requestId 65 two-byte characters", t.with({ requestId: "\u00e9".repeat(65) }), "inbox CLI request.requestId must be a non-empty string of at most 128 bytes"),
	t.ok("requestId 64 two-byte characters", t.with({ requestId: "\u00e9".repeat(64) })),
	t.err("timeoutMs not a number", t.with({ timeoutMs: "1000" }), "inbox CLI request.timeoutMs must be an integer between 1 and 120000"),
	t.err("timeoutMs 1.5", t.with({ timeoutMs: 1.5 }), "inbox CLI request.timeoutMs must be an integer between 1 and 120000"),
	t.err("timeoutMs 0", t.with({ timeoutMs: 0 }), "inbox CLI request.timeoutMs must be an integer between 1 and 120000"),
	t.err("timeoutMs INBOX_MAX_TIMEOUT_MS plus 1", t.with({ timeoutMs: INBOX_MAX_TIMEOUT_MS + 1 }), "inbox CLI request.timeoutMs must be an integer between 1 and 120000"),
	t.ok("timeoutMs INBOX_MAX_TIMEOUT_MS", t.with({ timeoutMs: INBOX_MAX_TIMEOUT_MS })),
	t.err("protocolVersion 2", t.with({ protocolVersion: 2 }), "inbox CLI request.protocolVersion must be an integer between 1 and 1"),
	t.ok("protocolVersion 1", t.with({ protocolVersion: 1 })),
	t.err("browser request missing", t.without("request"), "inbox browser request must be an object"),
	t.err("profile name missing", { type: "cli-inbox-request", requestId: "request-1", operation: "profile-get" }, "inbox profile name must be a non-empty string of at most 128 bytes"),
	t.err("profile name with spaces", { type: "cli-inbox-request", requestId: "request-1", operation: "profile-get", name: "bad name" }, "inbox profile name must use letters, numbers, dots, underscores or hyphens"),
	t.err("profile missing", { type: "cli-inbox-request", requestId: "request-1", operation: "profile-set", name: "work" }, "inbox profile must be an object"),
	t.err("provider unsupported", { type: "cli-inbox-request", requestId: "request-1", operation: "cache-get", name: "work", provider: "yahoo" }, "inbox provider must be one of protonmail, gmail, outlook"),
	t.err("cache missing", { type: "cli-inbox-request", requestId: "request-1", operation: "cache-set", name: "work", provider: "gmail" }, "inbox OAuth cache must be a string of at most 524288 bytes"),
]);

const cliProtoRows = rowsFor("cli-proto-request", (t) => [
	t.ok("ok"),
	t.err("type mismatch", t.with({ type: "cli-proto-result" }), "proto cli request.type must be \"cli-proto-request\""),
	t.err("requestId missing", t.without("requestId"), "proto cli request.requestId must be a non-empty string"),
	t.err("requestId empty", t.with({ requestId: "" }), "proto cli request.requestId must be a non-empty string"),
	t.err("requestId whitespace-only", t.with({ requestId: "   " }), "proto cli request.requestId must be a non-empty string"),
	t.err("requestId lone surrogate", t.with({ requestId: "\ud800" }), "proto cli request.requestId must be a non-empty string"),
	t.ok("requestId 128 characters", t.with({ requestId: "x".repeat(128) })),
	t.err("requestId 129 characters", t.with({ requestId: "x".repeat(129) }), "proto cli request.requestId exceeds 128 characters"),
	t.err("phase invalid", t.with({ phase: "launch" }), "proto cli request.phase must be \"scrape\" or \"plant\""),
	t.err("phase missing", t.without("phase"), "proto cli request.phase must be \"scrape\" or \"plant\""),
	t.err("slug invalid", t.with({ slug: "../escape" }), "proto cli request.slug must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$ (1-128 letters, digits, underscores, or hyphens; starts alphanumeric)"),
	t.err("slug missing", t.without("slug"), "proto cli request.slug must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$ (1-128 letters, digits, underscores, or hyphens; starts alphanumeric)"),
	t.err("markedUrl missing", t.without("markedUrl"), "proto cli request.markedUrl must be a non-empty string"),
	t.err("markedUrl not http", t.with({ markedUrl: "ftp://example.com/page" }), "proto cli request.markedUrl must be an http(s) URL"),
	t.err("markedUrl unparsable", t.with({ markedUrl: "not a url" }), "proto cli request.markedUrl must be an http(s) URL"),
	t.err("markedUrl over the marker limit", t.with({ markedUrl: `https://example.com/${"x".repeat(33_000)}` }), "proto cli request.markedUrl exceeds the marker URL limit"),
	t.err("timeoutMs not a number", t.with({ timeoutMs: "1000" }), "proto cli request.timeoutMs must be a finite number"),
	t.err("timeoutMs NaN", t.with({ timeoutMs: Number.NaN }), "proto cli request.timeoutMs must be a finite number"),
	t.err("timeoutMs 0", t.with({ timeoutMs: 0 }), "proto cli request.timeoutMs must be between 1 and 900000"),
	t.err("timeoutMs PROTO_MAX_TIMEOUT_MS plus 1", t.with({ timeoutMs: PROTO_MAX_TIMEOUT_MS + 1 }), "proto cli request.timeoutMs must be between 1 and 900000"),
	t.ok("timeoutMs PROTO_MAX_TIMEOUT_MS", t.with({ timeoutMs: PROTO_MAX_TIMEOUT_MS })),
	t.ok("timeoutMs omitted"),
	t.ok("protocolVersion value not checked", t.with({ protocolVersion: 99 })),
	t.err("extra top-level key", t.with({ extra: 1 }), "proto cli request has unknown field \"extra\""),
]);

const cliPwExtRows = rowsFor("cli-pw-ext-request", (t) => [
	t.ok("ok"),
	t.err("type mismatch", t.with({ type: "cli-pw-ext-cancel" }), "pw-ext CLI request.type must be \"cli-pw-ext-request\""),
	t.err("extra top-level key", t.with({ extra: 1 }), "pw-ext CLI request has unknown field \"extra\""),
	t.err("requestId missing", t.without("requestId"), "pw-ext CLI request.requestId must be a non-empty string"),
	t.err("requestId empty", t.with({ requestId: "" }), "pw-ext CLI request.requestId must be a non-empty string"),
	t.err("requestId whitespace-only", t.with({ requestId: "   " }), "pw-ext CLI request.requestId must be a non-empty string"),
	t.err("requestId lone surrogate", t.with({ requestId: "\ud800" }), "pw-ext CLI request.requestId must be a non-empty string"),
	t.ok("requestId 128 characters", t.with({ requestId: "x".repeat(128) })),
	t.err("requestId 129 characters", t.with({ requestId: "x".repeat(129) }), "pw-ext CLI request.requestId exceeds 128 characters"),
	t.err("request not an object", t.with({ request: "current" }), "pw-ext request must be an object"),
	...tabRequestRows(t),
	t.ok("timeoutMs omitted", t.without("timeoutMs")),
	t.err("timeoutMs 1.5", t.with({ timeoutMs: 1.5 }), "pw-ext CLI request.timeoutMs must be an integer between 1 and 300000"),
	t.err("timeoutMs 0", t.with({ timeoutMs: 0 }), "pw-ext CLI request.timeoutMs must be an integer between 1 and 300000"),
	t.err("timeoutMs PW_EXT_MAX_TIMEOUT_MS plus 1", t.with({ timeoutMs: PW_EXT_MAX_TIMEOUT_MS + 1 }), "pw-ext CLI request.timeoutMs must be an integer between 1 and 300000"),
	t.ok("timeoutMs PW_EXT_MAX_TIMEOUT_MS", t.with({ timeoutMs: PW_EXT_MAX_TIMEOUT_MS })),
]);

const cliPwExtCancelRows = rowsFor("cli-pw-ext-cancel", (t) => [
	t.ok("ok"),
	t.err("type mismatch", t.with({ type: "cli-pw-ext-request" }), "pw-ext CLI cancel.type must be \"cli-pw-ext-cancel\""),
	t.err("extra top-level key", t.with({ extra: 1 }), "pw-ext CLI cancel has unknown field \"extra\""),
	t.err("requestId missing", t.without("requestId"), "pw-ext CLI cancel.requestId must be a non-empty string"),
	t.err("requestId empty", t.with({ requestId: "" }), "pw-ext CLI cancel.requestId must be a non-empty string"),
	t.err("requestId whitespace-only", t.with({ requestId: "   " }), "pw-ext CLI cancel.requestId must be a non-empty string"),
	t.err("requestId lone surrogate", t.with({ requestId: "\ud800" }), "pw-ext CLI cancel.requestId must be a non-empty string"),
	t.ok("requestId 128 characters", t.with({ requestId: "x".repeat(128) })),
	t.err("requestId 129 characters", t.with({ requestId: "x".repeat(129) }), "pw-ext CLI cancel.requestId exceeds 128 characters"),
]);

const GOLDEN: readonly GoldenRow[] = [
	...inboxRequestRows,
	...inboxResultRows,
	...protoRequestRows,
	...protoResultRows,
	...protoProgressRows,
	...pwExtRequestRows,
	...pwExtCancelRows,
	...pwExtResultRows,
	...cliInboxRows,
	...cliProtoRows,
	...cliPwExtRows,
	...cliPwExtCancelRows,
];

function thrownBy(run: () => unknown): unknown {
	try {
		run();
	} catch (error) {
		return error;
	}
	return undefined;
}

describe("relay frame validators", () => {
	for (const row of GOLDEN) {
		it(`${row.type}: ${row.axis}`, () => {
			const thrown = thrownBy(() => VALIDATORS[row.type](row.frame));
			if (row.expect === "ok") {
				expect(thrown).toBeUndefined();
				return;
			}
			expect(thrown).toBeInstanceOf(TypeError);
			expect(thrown instanceof TypeError ? thrown.message : "").toBe(row.expect);
		});
	}
});

describe("golden table integrity", () => {
	const rowsOf = (type: GoldenType) => GOLDEN.filter((row) => row.type === type);
	const chatTypes = FRAME_TYPES.filter((type) => !type.startsWith("cli-"));

	it("covers exactly the 12 relay frame types", () => {
		expect([...new Set(GOLDEN.map((row) => row.type))].sort()).toEqual(
			[...FRAME_TYPES].sort(),
		);
	});

	it("keeps every type and axis pair unique", () => {
		const pairs = GOLDEN.map((row) => `${row.type}: ${row.axis}`);
		expect(new Set(pairs).size).toBe(pairs.length);
	});

	it("gives every row a non-empty expect", () => {
		expect(GOLDEN.every((row) => row.expect.length > 0)).toBe(true);
	});

	it("gives every type an ok, an invalid and a requestId row", () => {
		for (const type of FRAME_TYPES) {
			const rows = rowsOf(type);
			expect(rows.some((row) => row.expect === "ok")).toBe(true);
			expect(rows.some((row) => row.expect !== "ok")).toBe(true);
			expect(rows.some((row) => row.axis.startsWith("requestId"))).toBe(true);
		}
	});

	it("gives every chat frame an envelope row", () => {
		for (const type of chatTypes) {
			expect(rowsOf(type).some((row) => row.axis.startsWith("envelope"))).toBe(
				true,
			);
		}
	});

	it("gives every type an extra top-level key row", () => {
		for (const type of FRAME_TYPES) {
			expect(
				rowsOf(type).some((row) => row.axis.startsWith("extra top-level key")),
			).toBe(true);
		}
	});

	it("carries an oversize row for exactly the types that can reach the size check", () => {
		const unreachable: readonly string[] = OVERSIZE_UNREACHABLE;
		for (const type of chatTypes) {
			const hasRow = rowsOf(type).some((row) => row.axis === "oversize");
			expect(hasRow).toBe(!unreachable.includes(type));
		}
	});

	it("keeps five to ten precedence rows", () => {
		const count = GOLDEN.filter((row) => row.axis.startsWith("precedence ")).length;
		expect(count).toBeGreaterThanOrEqual(5);
		expect(count).toBeLessThanOrEqual(10);
	});
});
