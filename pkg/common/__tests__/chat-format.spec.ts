import { describe, expect, it } from "bun:test";
// Frame shapes below mirror the ratified "Slice-1 contract ratifications"
// subsection of Code Structure.
import {
	authorizeFrame,
	CHAT_MAX_PAYLOAD_BYTES,
	validateChatFrame,
	validateCommandManifest,
	validateSessionHandle,
} from "../src/index";

const PROTOCOL_VERSION = 1;

// --- Frame builders (one per ratified ChatFrame discriminant) -----------

function buildUserMessageFrame(overrides: Record<string, unknown> = {}) {
	return {
		type: "user-message" as const,
		sessionId: "session-a",
		token: "token-a",
		protocolVersion: PROTOCOL_VERSION,
		messageId: "msg-001",
		body: "hello agent",
		...overrides,
	};
}

function buildAckFrame(overrides: Record<string, unknown> = {}) {
	return {
		type: "ack" as const,
		sessionId: "session-a",
		protocolVersion: PROTOCOL_VERSION,
		messageId: "msg-001",
		...overrides,
	};
}

function buildAgentMessageFrame(overrides: Record<string, unknown> = {}) {
	return {
		type: "agent-message" as const,
		sessionId: "session-a",
		protocolVersion: PROTOCOL_VERSION,
		body: "here is my answer",
		...overrides,
	};
}

// Ratification pins the discriminant as "progress" (state: running |
// awaiting-input | agent-gone), not the earlier "status" naming.
function buildProgressFrame(overrides: Record<string, unknown> = {}) {
	return {
		type: "progress" as const,
		sessionId: "session-a",
		protocolVersion: PROTOCOL_VERSION,
		state: "running",
		...overrides,
	};
}

function buildCommandInvocationFrame(overrides: Record<string, unknown> = {}) {
	return {
		type: "command-invocation" as const,
		sessionId: "session-a",
		token: "token-a",
		protocolVersion: PROTOCOL_VERSION,
		commandLabel: "Build project",
		params: { target: "web" },
		...overrides,
	};
}

function buildCommandResultFrame(overrides: Record<string, unknown> = {}) {
	return {
		type: "command-result" as const,
		sessionId: "session-a",
		protocolVersion: PROTOCOL_VERSION,
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
		protocolVersion: PROTOCOL_VERSION,
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
		protocolVersion: PROTOCOL_VERSION,
		sessions: [buildSessionSummary()],
		...overrides,
	};
}

// Carries the REQUESTING session's own pair; role/workset describe the session
// being created, per the ratification.
function buildSessionCreateFrame(overrides: Record<string, unknown> = {}) {
	return {
		type: "session-create" as const,
		sessionId: "session-requester",
		token: "token-requester",
		protocolVersion: PROTOCOL_VERSION,
		role: "agent",
		workset: "billing-refactor",
		...overrides,
	};
}

// Outbound response: the new id/token nest under `newSession` rather than
// spreading at the envelope level, so no token rides an outbound envelope.
function buildSessionPendingFrame(overrides: Record<string, unknown> = {}) {
	return {
		type: "session-pending" as const,
		sessionId: "session-requester",
		protocolVersion: PROTOCOL_VERSION,
		newSession: {
			sessionId: "session-new",
			token: "token-new-000000000000000000",
		},
		...overrides,
	};
}

// Inbound close request from the page. Distinct from the session-closed
// broadcast so the capability check can gate which session a socket may close.
// Inbound liveness frame. The daemon notes activity and replies with nothing,
// so a keepalive never doubles the traffic it exists to minimise.
function buildKeepaliveFrame(overrides: Record<string, unknown> = {}) {
	return {
		type: "keepalive" as const,
		sessionId: "session-a",
		token: "token-a-0000000000000000000000",
		protocolVersion: PROTOCOL_VERSION,
		...overrides,
	};
}

function buildSessionCloseFrame(overrides: Record<string, unknown> = {}) {
	return {
		type: "session-close" as const,
		sessionId: "session-a",
		token: "token-a-0000000000000000000000",
		protocolVersion: PROTOCOL_VERSION,
		...overrides,
	};
}

function buildSessionClosedFrame(overrides: Record<string, unknown> = {}) {
	return {
		type: "session-closed" as const,
		sessionId: "session-a",
		protocolVersion: PROTOCOL_VERSION,
		...overrides,
	};
}

function buildHistoryRequestFrame(overrides: Record<string, unknown> = {}) {
	return {
		type: "history-request" as const,
		sessionId: "session-a",
		token: "token-a",
		protocolVersion: PROTOCOL_VERSION,
		...overrides,
	};
}

function buildHistoryResponseFrame(overrides: Record<string, unknown> = {}) {
	return {
		type: "history-response" as const,
		sessionId: "session-a",
		protocolVersion: PROTOCOL_VERSION,
		messages: [],
		...overrides,
	};
}

function buildConfigGetFrame(overrides: Record<string, unknown> = {}) {
	return {
		type: "config-get" as const,
		sessionId: "session-a",
		token: "token-a",
		protocolVersion: PROTOCOL_VERSION,
		key: "assetsDir",
		...overrides,
	};
}

function buildConfigSetFrame(overrides: Record<string, unknown> = {}) {
	return {
		type: "config-set" as const,
		sessionId: "session-a",
		token: "token-a",
		protocolVersion: PROTOCOL_VERSION,
		key: "assetsDir",
		value: "/home/user/.dg/assets",
		...overrides,
	};
}

function buildErrorFrame(overrides: Record<string, unknown> = {}) {
	return {
		type: "error" as const,
		sessionId: "session-a",
		protocolVersion: PROTOCOL_VERSION,
		message: "something went wrong",
		...overrides,
	};
}

function buildDaemonHandle(overrides: Record<string, unknown> = {}) {
	return {
		pid: 4242,
		port: 47411,
		instanceId: "instance-abc123",
		versions: { package: "1.0.0", protocol: 1 },
		...overrides,
	};
}

function buildSessionBootstrap(overrides: Record<string, unknown> = {}) {
	return {
		port: 47411,
		sessionId: "session-a",
		token: "token-a-0000000000000000000000",
		agentIdentity: "js",
		...overrides,
	};
}

// All 17 ratified discriminants; the request/broadcast splits are deliberate,
// so a token can never ride an outbound frame.
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
	["history-request", buildHistoryRequestFrame],
	["history-response", buildHistoryResponseFrame],
	["config-get", buildConfigGetFrame],
	["config-set", buildConfigSetFrame],
	["error", buildErrorFrame],
];

describe("validateChatFrame — frame type coverage", () => {
	for (const [type, build] of FRAME_FIXTURES) {
		it(`accepts a well-formed "${type}" frame`, () => {
			expect(() => validateChatFrame(build())).not.toThrow();
		});
	}

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

// The page originates session-close while the daemon broadcasts session-closed.
// Splitting them is what lets the capability check gate a cross-session close.
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
		// "a placeholder occupies a WHOLE argv element" — embedding one inside a
		// longer string (e.g. "--target={target}") is not a whole element.
		const manifest = [
			buildCommandEntry({ argv: ["bun", "run", "build", "--target={target}"] }),
		];
		expect(() => validateCommandManifest(manifest)).toThrow();
	});
});

describe("validateSessionHandle", () => {
	it("accepts a well-formed DaemonHandle", () => {
		const handle = buildDaemonHandle();
		expect(validateSessionHandle(handle)).toEqual(handle);
	});

	it("accepts a well-formed SessionBootstrap with exactly its four ratified fields", () => {
		const bootstrap = buildSessionBootstrap();
		expect(validateSessionHandle(bootstrap)).toEqual(bootstrap);
	});

	it("rejects a lockfile-shaped value that also carries a session token", () => {
		const tainted = buildDaemonHandle({
			token: "leaked-token-should-never-appear",
		});
		expect(() => validateSessionHandle(tainted)).toThrow();
	});
});

describe("validateChatFrame — CHAT_MAX_PAYLOAD_BYTES", () => {
	it("rejects a frame whose serialized size exceeds the published max-payload constant", () => {
		const oversizedBody = "x".repeat(CHAT_MAX_PAYLOAD_BYTES + 1);
		const frame = buildAgentMessageFrame({ body: oversizedBody });
		expect(() => validateChatFrame(frame)).toThrow();
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

// session-pending nests a token by ratified carve-out, but must still refuse
// one spread onto the envelope like every other outbound frame.
describe("validateChatFrame — session-pending still refuses an envelope-level token", () => {
	it("rejects a session-pending frame carrying a token beside its nested newSession", () => {
		const frame = buildSessionPendingFrame({ token: "leaked-envelope-token" });
		expect(() => validateChatFrame(frame)).toThrow();
	});
});

// config-set's value is `unknown` and legitimately falsy (false/0/null/"");
// presence must be checked with Object.hasOwn, not truthiness, or these regress to rejected.
describe("validateChatFrame — config-set distinguishes absent value from falsy value", () => {
	it.each([
		false,
		null,
		0,
		"",
	])("accepts a config-set frame whose value is the falsy literal %p", (value) => {
		const frame = buildConfigSetFrame({ value });
		expect(() => validateChatFrame(frame)).not.toThrow();
	});

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

describe("validateSessionHandle — rejects incomplete handles", () => {
	it("rejects a DaemonHandle-shaped value missing instanceId", () => {
		const handle = buildDaemonHandle();
		delete (handle as Record<string, unknown>).instanceId;
		expect(() => validateSessionHandle(handle)).toThrow();
	});

	it("rejects a SessionBootstrap-shaped value missing agentIdentity", () => {
		const bootstrap = buildSessionBootstrap();
		delete (bootstrap as Record<string, unknown>).agentIdentity;
		expect(() => validateSessionHandle(bootstrap)).toThrow();
	});
});
