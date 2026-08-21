import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
	authorizeFrame,
	CHAT_MAX_PAYLOAD_BYTES,
	CHAT_PROTOCOL_VERSION,
	fitHistoryPage,
	validateChatFrame,
	validateCommandManifest,
} from "../src/index";

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
	["config-result", buildConfigResultFrame],
];

function ratifiedDiscriminants(): string[] {
	const source = readFileSync(
		new URL("../src/chat-format.ts", import.meta.url),
		"utf8",
	);
	const start = source.indexOf("const CHAT_FRAME_TYPES = new Set([");
	const end = source.indexOf("]);", start);
	if (start < 0 || end < 0) throw new Error("CHAT_FRAME_TYPES not found");
	return Array.from(source.slice(start, end).matchAll(/"([a-z-]+)"/g)).map(
		(match) => match[1] as string,
	);
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
