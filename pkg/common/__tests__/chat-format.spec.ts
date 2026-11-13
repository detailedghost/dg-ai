import { describe, expect, it } from "bun:test";
import {
	type AnyRelayFeature,
	authorizeFrame,
	CHAT_FRAME_TYPES,
	CHAT_MAX_PAYLOAD_BYTES,
	CHAT_PROTOCOL_VERSION,
	type ChatFrame,
	fitHistoryPage,
	INBOUND_FRAME_TYPES,
	PROTO_MAX_TIMEOUT_MS,
	RELAY_FEATURES,
	type RelayChatFrame,
	type RelayCliFrame,
	relayFrameTypes,
	relayValidators,
	tryValidateSessionBootstrap,
	validateChatFrame,
	validateCommandManifest,
	validateLinkFrame,
	validateSessionAdopt,
} from "../src/index";
import { TEST_RELAY } from "./utils/relay-fixtures";

function buildUserMessageFrame(overrides: Record<string, unknown> = {}) {
	return {
		type: "user-message" as const,
		sessionId: "session-a",
		token: "token-a",
		protocolVersion: CHAT_PROTOCOL_VERSION,
		messageId: "msg-001",
		body: "hello agent",
		...overrides,
	};
}

function buildAckFrame(overrides: Record<string, unknown> = {}) {
	return {
		type: "ack" as const,
		sessionId: "session-a",
		protocolVersion: CHAT_PROTOCOL_VERSION,
		messageId: "msg-001",
		...overrides,
	};
}

function buildAgentMessageFrame(overrides: Record<string, unknown> = {}) {
	return {
		type: "agent-message" as const,
		sessionId: "session-a",
		protocolVersion: CHAT_PROTOCOL_VERSION,
		body: "here is my answer",
		...overrides,
	};
}

function buildProgressFrame(overrides: Record<string, unknown> = {}) {
	return {
		type: "progress" as const,
		sessionId: "session-a",
		protocolVersion: CHAT_PROTOCOL_VERSION,
		state: "running",
		...overrides,
	};
}

function buildCommandInvocationFrame(overrides: Record<string, unknown> = {}) {
	return {
		type: "command-invocation" as const,
		sessionId: "session-a",
		token: "token-a",
		protocolVersion: CHAT_PROTOCOL_VERSION,
		commandLabel: "Build project",
		params: { target: "web" },
		...overrides,
	};
}

function buildCommandResultFrame(overrides: Record<string, unknown> = {}) {
	return {
		type: "command-result" as const,
		sessionId: "session-a",
		protocolVersion: CHAT_PROTOCOL_VERSION,
		ok: true,
		output: "build ok",
		...overrides,
	};
}

function buildCommandEntry(overrides: Record<string, unknown> = {}) {
	return {
		label: "Build project",
		argv: ["bun", "run", "build", "{target}"],
		params: [{ name: "target", type: "string" }],
		...overrides,
	};
}

function buildManifestPublishFrame(overrides: Record<string, unknown> = {}) {
	return {
		type: "manifest-publish" as const,
		sessionId: "session-a",
		protocolVersion: CHAT_PROTOCOL_VERSION,
		commands: [buildCommandEntry()],
		...overrides,
	};
}

function buildSessionSummary(overrides: Record<string, unknown> = {}) {
	return {
		sessionId: "session-a",
		agentIdentity: "js",
		role: "agent",
		...overrides,
	};
}

function buildSessionListFrame(overrides: Record<string, unknown> = {}) {
	return {
		type: "session-list" as const,
		sessionId: "session-viewer",
		protocolVersion: CHAT_PROTOCOL_VERSION,
		sessions: [buildSessionSummary()],
		...overrides,
	};
}

function buildSessionCreateFrame(overrides: Record<string, unknown> = {}) {
	return {
		type: "session-create" as const,
		sessionId: "session-requester",
		token: "token-requester",
		protocolVersion: CHAT_PROTOCOL_VERSION,
		role: "agent",
		workset: "billing-refactor",
		...overrides,
	};
}

function buildSessionPendingFrame(overrides: Record<string, unknown> = {}) {
	return {
		type: "session-pending" as const,
		sessionId: "session-requester",
		protocolVersion: CHAT_PROTOCOL_VERSION,
		newSession: {
			sessionId: "session-new",
			token: "token-new-000000000000000000",
		},
		...overrides,
	};
}

function buildKeepaliveFrame(overrides: Record<string, unknown> = {}) {
	return {
		type: "keepalive" as const,
		sessionId: "session-a",
		token: "token-a-0000000000000000000000",
		protocolVersion: CHAT_PROTOCOL_VERSION,
		...overrides,
	};
}

function buildSessionCloseFrame(overrides: Record<string, unknown> = {}) {
	return {
		type: "session-close" as const,
		sessionId: "session-a",
		token: "token-a-0000000000000000000000",
		protocolVersion: CHAT_PROTOCOL_VERSION,
		...overrides,
	};
}

function buildSessionClosedFrame(overrides: Record<string, unknown> = {}) {
	return {
		type: "session-closed" as const,
		sessionId: "session-a",
		protocolVersion: CHAT_PROTOCOL_VERSION,
		...overrides,
	};
}

function buildHistoryRequestFrame(overrides: Record<string, unknown> = {}) {
	return {
		type: "history-request" as const,
		sessionId: "session-a",
		token: "token-a",
		protocolVersion: CHAT_PROTOCOL_VERSION,
		...overrides,
	};
}

function buildHistoryResponseFrame(overrides: Record<string, unknown> = {}) {
	return {
		type: "history-response" as const,
		sessionId: "session-a",
		protocolVersion: CHAT_PROTOCOL_VERSION,
		messages: [],
		...overrides,
	};
}

function buildConfigGetFrame(overrides: Record<string, unknown> = {}) {
	return {
		type: "config-get" as const,
		sessionId: "session-a",
		token: "token-a",
		protocolVersion: CHAT_PROTOCOL_VERSION,
		key: "assetsDir",
		...overrides,
	};
}

function buildConfigSetFrame(overrides: Record<string, unknown> = {}) {
	return {
		type: "config-set" as const,
		sessionId: "session-a",
		token: "token-a",
		protocolVersion: CHAT_PROTOCOL_VERSION,
		key: "assetsDir",
		value: "/home/user/.dg/assets",
		...overrides,
	};
}

function buildErrorFrame(overrides: Record<string, unknown> = {}) {
	return {
		type: "error" as const,
		sessionId: "session-a",
		protocolVersion: CHAT_PROTOCOL_VERSION,
		message: "something went wrong",
		...overrides,
	};
}

function buildConfigResultFrame(overrides: Record<string, unknown> = {}) {
	return {
		type: "config-result" as const,
		sessionId: "session-a",
		protocolVersion: CHAT_PROTOCOL_VERSION,
		key: "theme",
		value: "dark",
		...overrides,
	};
}

function buildInboxBrowserRequestFrame(
	overrides: Record<string, unknown> = {},
) {
	return {
		type: "inbox-browser-request",
		sessionId: "session-a",
		requestId: "inbox-a",
		protocolVersion: CHAT_PROTOCOL_VERSION,
		request: { operation: "list-folders" },
		...overrides,
	};
}

function buildInboxBrowserResultFrame(overrides: Record<string, unknown> = {}) {
	return {
		type: "inbox-browser-result",
		sessionId: "session-a",
		requestId: "inbox-a",
		protocolVersion: CHAT_PROTOCOL_VERSION,
		token: "token-a",
		ok: true,
		data: { folders: [] },
		...overrides,
	};
}

function buildProtoBrowserRequestFrame(overrides: Record<string, unknown> = {}) {
	return {
		type: "proto-browser-request",
		sessionId: "session-a",
		requestId: "proto-a",
		protocolVersion: CHAT_PROTOCOL_VERSION,
		phase: "scrape",
		slug: "account-summary-1a2b3c4d",
		markedUrl: "https://example.test/account#_proto=fixture",
		...overrides,
	};
}

function buildProtoBrowserResultFrame(overrides: Record<string, unknown> = {}) {
	return {
		type: "proto-browser-result",
		sessionId: "session-a",
		requestId: "proto-a",
		protocolVersion: CHAT_PROTOCOL_VERSION,
		token: "token-a",
		ok: true,
		data: {
			kind: "style-guide",
			styleGuide: {
				meta: {
					url: "https://example.test/account",
					scrapedAt: 1,
					sameOrigin: true,
				},
				tokens: {
					customProps: {},
					colors: ["rgb(0, 0, 0)"],
					fontStack: "sans-serif",
					typeScale: [],
					spacing: [],
					radii: [],
					shadows: [],
				},
				components: { button: {}, input: {}, link: {} },
			},
		},
		...overrides,
	};
}

function buildProtoBrowserProgressFrame(
	overrides: Record<string, unknown> = {},
) {
	return {
		type: "proto-browser-progress",
		sessionId: "session-a",
		requestId: "proto-a",
		protocolVersion: CHAT_PROTOCOL_VERSION,
		token: "token-a",
		status: "ready; scraping the style guide",
		...overrides,
	};
}

function buildPwExtBrowserRequestFrame() {
	return {
		type: "pw-ext-browser-request",
		sessionId: "session-a",
		requestId: "pw-a",
		protocolVersion: CHAT_PROTOCOL_VERSION,
		request: { verb: "current" },
		timeoutMs: 1000,
	};
}

function buildPwExtBrowserCancelFrame() {
	return {
		type: "pw-ext-browser-cancel",
		sessionId: "session-a",
		requestId: "pw-a",
		protocolVersion: CHAT_PROTOCOL_VERSION,
	};
}

function buildPwExtBrowserResultFrame() {
	return {
		type: "pw-ext-browser-result",
		sessionId: "session-a",
		requestId: "pw-a",
		protocolVersion: CHAT_PROTOCOL_VERSION,
		token: "token-a",
		ok: true,
		data: { text: "### Page" },
	};
}

function buildOverwatchStateFrame(overrides: Record<string, unknown> = {}) {
	return {
		type: "overwatch-state" as const,
		sessionId: "__overwatch__",
		protocolVersion: CHAT_PROTOCOL_VERSION,
		board: { lanes: [], merges: [] },
		...overrides,
	};
}

function buildOverwatchOpenFrame(overrides: Record<string, unknown> = {}) {
	return {
		type: "overwatch-open" as const,
		sessionId: "__overwatch__",
		protocolVersion: CHAT_PROTOCOL_VERSION,
		requestId: "open-request-1",
		...overrides,
	};
}

function buildPwExtCredentialStoreFrame(overrides: Record<string, unknown> = {}) {
	return {
		type: "pw-ext-credential-store" as const,
		sessionId: "session-a",
		token: "token-a",
		protocolVersion: CHAT_PROTOCOL_VERSION,
		requestId: "store-1",
		site: "example.test",
		name: "owa-token",
		value: "fake-marker-value-for-tests",
		meta: { site: "https://mail.example.test", source: "header:authorization", createdBy: "pw --ext credential save" },
		...overrides,
	};
}

function buildPwExtCredentialStoredFrame(overrides: Record<string, unknown> = {}) {
	return {
		type: "pw-ext-credential-stored" as const,
		sessionId: "session-a",
		protocolVersion: CHAT_PROTOCOL_VERSION,
		requestId: "store-1",
		ok: true,
		name: "pw/example.test/owa-token",
		...overrides,
	};
}

function buildOverwatchOpenResultFrame(
	overrides: Record<string, unknown> = {},
) {
	return {
		type: "overwatch-open-result" as const,
		sessionId: "session-a",
		token: "token-a",
		protocolVersion: CHAT_PROTOCOL_VERSION,
		requestId: "open-request-1",
		ok: true,
		...overrides,
	};
}

const FRAME_FIXTURES: ReadonlyArray<[string, () => Record<string, unknown>]> = [
	["user-message", buildUserMessageFrame],
	["ack", buildAckFrame],
	["agent-message", buildAgentMessageFrame],
	["progress", buildProgressFrame],
	["command-invocation", buildCommandInvocationFrame],
	["command-result", buildCommandResultFrame],
	["manifest-publish", buildManifestPublishFrame],
	["session-list", buildSessionListFrame],
	["session-create", buildSessionCreateFrame],
	["session-pending", buildSessionPendingFrame],
	["keepalive", buildKeepaliveFrame],
	["session-close", buildSessionCloseFrame],
	["session-closed", buildSessionClosedFrame],
	["session-disconnect", () => buildSessionCloseFrame({ type: "session-disconnect" })],
	["session-disconnected", () => buildSessionClosedFrame({ type: "session-disconnected" })],
	["history-request", buildHistoryRequestFrame],
	["history-response", buildHistoryResponseFrame],
	["config-get", buildConfigGetFrame],
	["config-set", buildConfigSetFrame],
	["error", buildErrorFrame],
	["config-result", buildConfigResultFrame],
	["inbox-browser-request", buildInboxBrowserRequestFrame],
	["inbox-browser-result", buildInboxBrowserResultFrame],
	["proto-browser-request", buildProtoBrowserRequestFrame],
	["proto-browser-result", buildProtoBrowserResultFrame],
	["proto-browser-progress", buildProtoBrowserProgressFrame],
	["pw-ext-browser-request", buildPwExtBrowserRequestFrame],
	["pw-ext-browser-cancel", buildPwExtBrowserCancelFrame],
	["pw-ext-browser-result", buildPwExtBrowserResultFrame],
	["overwatch-state", buildOverwatchStateFrame],
	["overwatch-open", buildOverwatchOpenFrame],
	["overwatch-open-result", buildOverwatchOpenResultFrame],
	["pw-ext-credential-store", buildPwExtCredentialStoreFrame],
	["pw-ext-credential-stored", buildPwExtCredentialStoredFrame],
];

function ratifiedDiscriminants(): string[] {
	return [...CHAT_FRAME_TYPES];
}

describe("validateChatFrame — frame type coverage", () => {
	for (const [type, build] of FRAME_FIXTURES) {
		it(`accepts a well-formed "${type}" frame`, () => {
			expect(() => validateChatFrame(build())).not.toThrow();
		});
	}

	it("covers every discriminant the production module ratifies, leaving no frame type unexercised", () => {
		expect([...FRAME_FIXTURES.map(([type]) => type)].sort()).toEqual(
			ratifiedDiscriminants().sort(),
		);
	});

	it("rejects an unknown discriminant", () => {
		expect(() =>
			validateChatFrame({ type: "not-a-real-type", sessionId: "session-a" }),
		).toThrow();
	});

	it("rejects a frame missing sessionId", () => {
		const frame = buildAgentMessageFrame();
		delete (frame as Record<string, unknown>).sessionId;
		expect(() => validateChatFrame(frame)).toThrow();
	});
});

describe("validateChatFrame — outbound frames never carry a token", () => {
	it("rejects an outbound frame that carries a token field as malformed", () => {
		const frame = buildAgentMessageFrame({ token: "should-not-be-here" });
		expect(() => validateChatFrame(frame)).toThrow();
	});
});

describe("validateChatFrame — session-close is inbound, session-closed is not", () => {
	it("requires a token on a page-originated session-close request", () => {
		const { token, ...withoutToken } = buildSessionCloseFrame();
		expect(() => validateChatFrame(buildSessionCloseFrame())).not.toThrow();
		expect(() => validateChatFrame(withoutToken)).toThrow();
	});

	it("rejects a token on the outbound session-closed broadcast", () => {
		const frame = buildSessionClosedFrame({ token: "should-not-be-here" });
		expect(() => validateChatFrame(frame)).toThrow();
	});

	it("refuses a close aimed at a session the socket holds no capability for", () => {
		const frame = buildSessionCloseFrame({
			sessionId: "session-b",
			token: "token-a-0000000000000000000000",
		});
		const capabilities = new Map([
			["session-a", "token-a-0000000000000000000000"],
		]);
		expect(() => authorizeFrame(frame, capabilities)).toThrow();
	});

	it("authorizes a close aimed at a session the socket does hold", () => {
		const frame = buildSessionCloseFrame();
		const capabilities = new Map([
			["session-a", "token-a-0000000000000000000000"],
		]);
		expect(() => authorizeFrame(frame, capabilities)).not.toThrow();
	});
});

describe("authorizeFrame — capability-set authorization", () => {
	it("authorizes an inbound frame whose sessionId/token pair matches the capability set", () => {
		const frame = buildUserMessageFrame({
			sessionId: "session-a",
			token: "token-a",
		});
		const capabilities = new Map([["session-a", "token-a"]]);
		expect(() => authorizeFrame(frame, capabilities)).not.toThrow();
	});

	it("rejects an inbound frame for a sessionId absent from the capability set", () => {
		const frame = buildUserMessageFrame({
			sessionId: "session-a",
			token: "token-a",
		});
		const capabilities = new Map([["session-other", "token-other"]]);
		expect(() => authorizeFrame(frame, capabilities)).toThrow();
	});

	it("rejects an inbound frame whose token does not match the known pair", () => {
		const frame = buildUserMessageFrame({
			sessionId: "session-a",
			token: "token-a",
		});
		const capabilities = new Map([["session-a", "a-different-token"]]);
		expect(() => authorizeFrame(frame, capabilities)).toThrow();
	});

	it("authorizes a session-create request against the requesting session's own pair", () => {
		const frame = buildSessionCreateFrame({
			sessionId: "session-requester",
			token: "token-requester",
		});
		const capabilities = new Map([["session-requester", "token-requester"]]);
		expect(() => authorizeFrame(frame, capabilities)).not.toThrow();
	});
});

describe("validateChatFrame — session-pending nests the new session's credentials", () => {
	it("keeps the new session's id/token nested, never spread at the envelope level", () => {
		const frame = buildSessionPendingFrame();
		// biome-ignore lint: test needs to read fields off the validated union
		const validated = validateChatFrame(frame) as any;
		expect(validated.newSession).toEqual({
			sessionId: "session-new",
			token: "token-new-000000000000000000",
		});
		expect(Object.hasOwn(validated, "token")).toBe(false);
		expect(validated.sessionId).toBe("session-requester");
	});
});

describe("validateChatFrame — session-list SessionSummary entries", () => {
	it("accepts a summary entry carrying an optional workset label", () => {
		const frame = buildSessionListFrame({
			sessions: [
				buildSessionSummary({ workset: "billing-refactor", role: "agent" }),
			],
		});
		expect(() => validateChatFrame(frame)).not.toThrow();
	});

	it("accepts a summary entry with no workset label present at all", () => {
		const frame = buildSessionListFrame({
			sessions: [buildSessionSummary({ role: "orchestrator" })],
		});
		expect(() => validateChatFrame(frame)).not.toThrow();
	});

	it("rejects a summary entry with an unknown role value", () => {
		const frame = buildSessionListFrame({
			sessions: [buildSessionSummary({ role: "supervisor" })],
		});
		expect(() => validateChatFrame(frame)).toThrow();
	});

	it.each(["cli", "gone", "idle", undefined])("accepts a summary entry whose presence is %p", (presence) => {
		const frame = buildSessionListFrame({
			sessions: [buildSessionSummary({ presence })],
		});
		expect(() => validateChatFrame(frame)).not.toThrow();
	});

	it('rejects a summary entry whose presence is "waiting"', () => {
		const frame = buildSessionListFrame({
			sessions: [buildSessionSummary({ presence: "waiting" as never })],
		});
		expect(() => validateChatFrame(frame)).toThrow(
			'presence must be "cli", "gone", or "idle"',
		);
	});
});

describe("validateCommandManifest", () => {
	it("accepts argv arrays with typed param slots", () => {
		const manifest = [buildCommandEntry()];
		expect(validateCommandManifest(manifest)).toEqual(manifest);
	});

	it("rejects an entry declaring a command string instead of argv", () => {
		const manifest = [{ label: "Build", command: "bun run build" }];
		expect(() => validateCommandManifest(manifest)).toThrow();
	});

	it("rejects an entry whose argv is a string rather than an array", () => {
		const manifest = [{ label: "Build", argv: "bun run build", params: [] }];
		expect(() => validateCommandManifest(manifest)).toThrow();
	});

	it("rejects a placeholder embedded within a larger argv element", () => {
		const manifest = [
			buildCommandEntry({ argv: ["bun", "run", "build", "--target={target}"] }),
		];
		expect(() => validateCommandManifest(manifest)).toThrow();
	});
});

describe("validateChatFrame — CHAT_MAX_PAYLOAD_BYTES", () => {
	it("rejects a frame whose serialized size exceeds the published max-payload constant", () => {
		const oversizedBody = "x".repeat(CHAT_MAX_PAYLOAD_BYTES + 1);
		const frame = buildAgentMessageFrame({ body: oversizedBody });
		expect(() => validateChatFrame(frame)).toThrow();
	});
});

describe("validateChatFrame — proto-browser-request URL", () => {
	it("accepts http and https and rejects other schemes", () => {
		expect(() =>
			validateChatFrame(
				buildProtoBrowserRequestFrame({
					markedUrl: "http://example.test/account",
				}),
			),
		).not.toThrow();
		expect(() =>
			validateChatFrame(
				buildProtoBrowserRequestFrame({ markedUrl: "javascript:alert(1)" }),
			),
		).toThrow(/http\(s\)/);
		expect(() =>
			validateChatFrame(
				buildProtoBrowserRequestFrame({
					markedUrl: `https://example.test/${"a".repeat(40_000)}`,
				}),
			),
		).toThrow(/marker URL limit/);
	});

	it("accepts the daemon relay timeout and rejects one past the cap", () => {
		expect(() =>
			validateChatFrame(buildProtoBrowserRequestFrame({ timeoutMs: 45_000 })),
		).not.toThrow();
		expect(() =>
			validateChatFrame(
				buildProtoBrowserRequestFrame({ timeoutMs: PROTO_MAX_TIMEOUT_MS + 1 }),
			),
		).toThrow(/timeoutMs/);
	});
});

describe("validateChatFrame — round-trip serialization", () => {
	it("re-validates a JSON round-tripped frame as deep-equal to the original", () => {
		const original = buildManifestPublishFrame();
		const roundTripped = JSON.parse(JSON.stringify(original));
		expect(validateChatFrame(roundTripped)).toEqual(original);
	});
});

describe("validateChatFrame — protocolVersion envelope field", () => {
	it("rejects a frame with no protocolVersion at all", () => {
		const frame = buildAgentMessageFrame();
		delete (frame as Record<string, unknown>).protocolVersion;
		expect(() => validateChatFrame(frame)).toThrow();
	});

	it("rejects a frame whose protocolVersion is not a finite number", () => {
		const frame = buildAgentMessageFrame({ protocolVersion: "1" });
		expect(() => validateChatFrame(frame)).toThrow();
	});
});

describe("validateChatFrame — session-pending still refuses an envelope-level token", () => {
	it("rejects a session-pending frame carrying a token beside its nested newSession", () => {
		const frame = buildSessionPendingFrame({ token: "leaked-envelope-token" });
		expect(() => validateChatFrame(frame)).toThrow();
	});
});

describe("validateChatFrame — config-set distinguishes absent value from falsy value", () => {
	it.each([false, null, 0, ""])(
		"accepts a config-set frame whose value is the falsy literal %p",
		(value) => {
			const frame = buildConfigSetFrame({ value });
			expect(() => validateChatFrame(frame)).not.toThrow();
		},
	);

	it("rejects a config-set frame with no value field at all", () => {
		const frame = buildConfigSetFrame();
		delete (frame as Record<string, unknown>).value;
		expect(() => validateChatFrame(frame)).toThrow();
	});
});

describe("authorizeFrame — refuses to authorize a frame with no token to check", () => {
	it("throws rather than silently authorizing an outbound-shaped frame", () => {
		const frame = buildAgentMessageFrame();
		delete (frame as Record<string, unknown>).token;
		const capabilities = new Map([["session-a", "token-a"]]);
		expect(() => authorizeFrame(frame, capabilities)).toThrow();
	});
});

describe("validateCommandManifest — malformed param slots", () => {
	it("rejects a param entry missing its type", () => {
		const manifest = [buildCommandEntry({ params: [{ name: "target" }] })];
		expect(() => validateCommandManifest(manifest)).toThrow();
	});

	it("rejects a param entry missing its name", () => {
		const manifest = [buildCommandEntry({ params: [{ type: "string" }] })];
		expect(() => validateCommandManifest(manifest)).toThrow();
	});

	it("rejects a non-record entry in the manifest array", () => {
		expect(() => validateCommandManifest(["not-a-record"])).toThrow();
	});
});

describe("fitHistoryPage", () => {
	function item(seq: number, bodyBytes: number) {
		return {
			seq,
			id: `msg-${seq}`,
			role: "user" as const,
			body: "x".repeat(bodyBytes),
			createdAt: "2026-08-18T00:00:00.000Z",
		};
	}

	it("keeps a whole history that already fits, unchanged and in seq order", () => {
		const items = [item(1, 10), item(2, 10), item(3, 10)];

		expect(fitHistoryPage(items, 100)).toEqual(items);
	});

	it("drops the oldest items so the carrying frame stays under CHAT_MAX_PAYLOAD_BYTES", () => {
		const items = [1, 2, 3, 4, 5].map((seq) => item(seq, 300_000));

		const page = fitHistoryPage(items, 100);

		expect(page.map((i) => i.seq)).toEqual([3, 4, 5]);
		expect(
			new TextEncoder().encode(JSON.stringify({ messages: page })).length,
		).toBeLessThan(CHAT_MAX_PAYLOAD_BYTES);
	});

	it("returns an empty page rather than an oversized frame when even the newest item cannot fit", () => {
		expect(fitHistoryPage([item(1, CHAT_MAX_PAYLOAD_BYTES)], 100)).toEqual([]);
	});

	it("counts the carrying frame's own overhead against the budget", () => {
		const items = [item(1, 500_000), item(2, 500_000)];

		expect(fitHistoryPage(items, 0).length).toBe(2);
		expect(fitHistoryPage(items, 48_600).length).toBe(1);
	});
});

describe("validateChatFrame — error frame code", () => {
	it("accepts an error frame with the invalid-session code", () => {
		expect(() =>
			validateChatFrame(buildErrorFrame({ code: "invalid-session" })),
		).not.toThrow();
	});

	it("rejects an error frame with an unknown code", () => {
		expect(() =>
			validateChatFrame(buildErrorFrame({ code: "nope" })),
		).toThrow();
	});
});

const MASTER_CHAT_FRAME_TYPES = [
	"inbox-browser-request",
	"inbox-browser-result",
	"proto-browser-request",
	"proto-browser-result",
	"proto-browser-progress",
	"pw-ext-browser-request",
	"pw-ext-browser-cancel",
	"pw-ext-browser-result",
	"user-message",
	"ack",
	"agent-message",
	"progress",
	"command-invocation",
	"command-result",
	"manifest-publish",
	"session-list",
	"session-create",
	"session-pending",
	"keepalive",
	"session-close",
	"session-disconnect",
	"session-closed",
	"session-disconnected",
	"history-request",
	"history-response",
	"config-get",
	"config-set",
	"error",
	"config-result",
	"overwatch-state",
	"overwatch-open",
	"overwatch-open-result",
	"pw-ext-credential-store",
	"pw-ext-credential-stored",
];

const MASTER_INBOUND_FRAME_TYPES = [
	"inbox-browser-result",
	"proto-browser-result",
	"proto-browser-progress",
	"pw-ext-browser-result",
	"user-message",
	"command-invocation",
	"session-create",
	"session-close",
	"session-disconnect",
	"keepalive",
	"history-request",
	"config-get",
	"config-set",
	"overwatch-open-result",
	"pw-ext-credential-store",
];

describe("pw-ext-credential-store frame", () => {
	it.each([
		["a name with a slash", { name: "a/b" }],
		["a site with a port", { site: "localhost:3000" }],
		["an empty value", { value: "" }],
		["secret-looking meta", { meta: { tokenValue: "x" } }],
		["no token", { token: undefined }],
	])("rejects %s and never echoes the value", (_, overrides) => {
		let message = "";
		try {
			validateChatFrame(buildPwExtCredentialStoreFrame(overrides));
		} catch (error) {
			message = String(error);
		}
		expect(message).not.toBe("");
		expect(message).not.toContain("fake-marker-value-for-tests");
	});
});

const FIXTURE_BY_TYPE = new Map(FRAME_FIXTURES);

describe("derived frame type sets", () => {
	it("derives CHAT_FRAME_TYPES equal to the ratified list", () => {
		expect([...CHAT_FRAME_TYPES].sort()).toEqual(
			[...MASTER_CHAT_FRAME_TYPES].sort(),
		);
	});

	it("derives INBOUND_FRAME_TYPES equal to the inbound list", () => {
		expect([...INBOUND_FRAME_TYPES].sort()).toEqual(
			[...MASTER_INBOUND_FRAME_TYPES].sort(),
		);
	});
});

describe("relay tables drive the frame validation", () => {
	const features: readonly AnyRelayFeature[] = RELAY_FEATURES;
	for (const feature of features) {
		const { frames } = feature;
		const browserTypes = [
			frames.browserRequest,
			frames.browserResult,
			frames.browserCancel,
			frames.browserProgress,
		].filter((type) => type !== undefined);

		it(`${feature.name} has one validator per browser frame`, () => {
			expect(Object.keys(feature.validators).sort()).toEqual(
				[...browserTypes].sort(),
			);
		});

		it(`${feature.name} marks only results and progress as inbound`, () => {
			expect([...feature.inbound].sort()).toEqual(
				[frames.browserResult, frames.browserProgress]
					.filter((type) => type !== undefined)
					.sort(),
			);
		});

		for (const type of browserTypes) {
			const build = FIXTURE_BY_TYPE.get(type);
			const inbound = feature.inbound.includes(type);
			it(
				inbound
					? `requires a token on ${type}`
					: `refuses a token on ${type}`,
				() => {
					const frame = build?.() as Record<string, unknown>;
					expect(() => validateChatFrame(frame)).not.toThrow();
					if (inbound) {
						const { token, ...withoutToken } = frame;
						expect(token).toBeString();
						expect(() => validateChatFrame(withoutToken)).toThrow(
							"chat frame.token must be a non-empty string",
						);
					} else {
						expect(() =>
							validateChatFrame({ ...frame, token: "token-a" }),
						).toThrow(`must not be present on outbound "${type}" frames`);
					}
				},
			);
		}
	}
});

describe("a synthetic relay table is picked up by every derivation", () => {
	const FEATURES = [...RELAY_FEATURES, TEST_RELAY] as const;

	it("adds its browser frames to the type list", () => {
		expect(relayFrameTypes(FEATURES, "all")).toEqual(
			expect.arrayContaining([
				"test-browser-request",
				"test-browser-result",
				"test-browser-cancel",
				"test-browser-progress",
			]),
		);
	});

	it("adds only its result and progress frames to the inbound list", () => {
		const inbound = relayFrameTypes(FEATURES, "inbound");
		expect(inbound).toEqual(
			expect.arrayContaining(["test-browser-result", "test-browser-progress"]),
		);
		expect(inbound).not.toContain("test-browser-request");
	});

	it("adds one validator per browser frame to the validator map", () => {
		const validators = relayValidators(FEATURES);
		expect(validators.get("test-browser-request")).toBe(
			TEST_RELAY.validators["test-browser-request"],
		);
		expect(validators.size).toBe(
			RELAY_FEATURES.reduce(
				(count, { validators }) => count + Object.keys(validators).length,
				0,
			) + Object.keys(TEST_RELAY.validators).length,
		);
	});

	it("adds its frames to the derived ChatFrame and CliFrame members", () => {
		type Synthetic = RelayChatFrame<typeof TEST_RELAY>;
		const cancel = {
			type: "test-browser-cancel",
			sessionId: "session-a",
			protocolVersion: 1,
			requestId: "r1",
		} satisfies Extract<Synthetic, { type: "test-browser-cancel" }>;
		const progress = {
			type: "test-browser-progress",
			sessionId: "session-a",
			protocolVersion: 1,
			token: "token-a",
			requestId: "r1",
			status: "working",
		} satisfies Extract<Synthetic, { type: "test-browser-progress" }>;
		const cli = {
			type: "cli-test-cancel",
			requestId: "r1",
		} satisfies RelayCliFrame<typeof TEST_RELAY>;
		expect([cancel.type, progress.type, cli.type]).toHaveLength(3);
	});
});

describe("ChatFrame relay members keep their wire shape", () => {
	type KeysEqual<A extends PropertyKey, B extends PropertyKey> = [A] extends [B]
		? [B] extends [A]
			? true
			: false
		: false;
	type PwRequest = Extract<ChatFrame, { type: "pw-ext-browser-request" }>;
	type ProtoResult = Extract<ChatFrame, { type: "proto-browser-result" }>;

	it("keeps the pw-ext request keys with a required timeoutMs and no token", () => {
		const keys: KeysEqual<
			keyof PwRequest,
			"type" | "sessionId" | "protocolVersion" | "requestId" | "request" | "timeoutMs"
		> = true;
		const timeout: PwRequest["timeoutMs"] extends number ? true : false = true;
		expect([keys, timeout]).toEqual([true, true]);
	});

	it("keeps the proto result keys with optional data, notReady and error", () => {
		const keys: KeysEqual<
			keyof ProtoResult,
			| "type"
			| "sessionId"
			| "protocolVersion"
			| "token"
			| "requestId"
			| "ok"
			| "data"
			| "notReady"
			| "error"
		> = true;
		const success = {
			type: "proto-browser-result",
			sessionId: "session-a",
			protocolVersion: 1,
			token: "token-a",
			requestId: "r1",
			ok: true,
		} satisfies ProtoResult;
		expect([keys, success.ok]).toEqual([true, true]);
	});
});

describe("tryValidateSessionBootstrap", () => {
	const bootstrap = {
		port: 47823,
		sessionId: "session-a",
		token: "token-a",
		agentIdentity: "claude",
	};

	it("returns a valid bootstrap", () => {
		expect(tryValidateSessionBootstrap(bootstrap)).toEqual(bootstrap);
	});

	it("returns undefined instead of throwing for an invalid bootstrap", () => {
		expect(tryValidateSessionBootstrap({ ...bootstrap, token: "" })).toBeUndefined();
		expect(tryValidateSessionBootstrap("nope")).toBeUndefined();
	});
});

describe("validateSessionAdopt", () => {
	const frame = {
		type: "session-adopt" as const,
		bootstrap: {
			port: 47823,
			sessionId: "session-a",
			token: "token-a",
			agentIdentity: "claude",
			daemonId: "daemon-a",
		},
	};

	it("accepts a complete session-adopt frame", () => {
		expect(validateSessionAdopt(frame)).toEqual(frame);
	});

	it.each(["port", "sessionId", "token", "agentIdentity", "daemonId"])(
		"rejects a frame whose bootstrap lacks %s",
		(field) => {
			const { [field]: _omitted, ...bootstrap } = frame.bootstrap as Record<
				string,
				unknown
			>;
			expect(() => validateSessionAdopt({ ...frame, bootstrap })).toThrow();
		},
	);

	it("rejects a frame of another type", () => {
		expect(() => validateSessionAdopt({ ...frame, type: "session-list" })).toThrow();
	});
});

describe("validateLinkFrame", () => {
	it("accepts a link-ready frame", () => {
		expect(validateLinkFrame({ type: "link-ready" })).toEqual({
			type: "link-ready",
		});
	});

	it("accepts a link-ping frame", () => {
		expect(validateLinkFrame({ type: "link-ping" })).toEqual({
			type: "link-ping",
		});
	});

	it.each([{ type: "link-other" }, { type: "keepalive" }, {}, "link-ready", null])(
		"rejects %p",
		(value) => {
			expect(() => validateLinkFrame(value)).toThrow();
		},
	);
});
