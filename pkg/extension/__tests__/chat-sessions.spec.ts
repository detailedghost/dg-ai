import { expect, test } from "bun:test";
import { CHAT_PROTOCOL_VERSION } from "@dg/common";
import {
	buildAgentMessageFrame,
	buildSessionListFrame,
} from "./utils/frame-fixtures";

const { createChatSessions } = await import("@/lib/features/chat-sessions");

function buildProgressFrame(overrides: Record<string, unknown> = {}) {
	return {
		type: "progress" as const,
		sessionId: "session-a",
		protocolVersion: CHAT_PROTOCOL_VERSION,
		state: "running" as const,
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

test("a freshly listed session has no status until an explicit progress frame arrives — never inferred from silence", () => {
	const store = createChatSessions();
	store.applyFrame(
		buildSessionListFrame([
			{ sessionId: "session-a", agentIdentity: "claude-orchestrator" },
		]),
	);

	expect(store.get("session-a")?.status).toBe("unknown");
});

test("status tracks the progress frame's explicit state field through all three values, including agent-gone", () => {
	const store = createChatSessions();
	store.applyFrame(
		buildSessionListFrame([
			{ sessionId: "session-a", agentIdentity: "claude-orchestrator" },
		]),
	);

	store.applyFrame(buildProgressFrame({ state: "running" }));
	expect(store.get("session-a")?.status).toBe("running");

	store.applyFrame(buildProgressFrame({ state: "awaiting-input" }));
	expect(store.get("session-a")?.status).toBe("awaiting-input");

	store.applyFrame(buildProgressFrame({ state: "agent-gone" }));
	expect(store.get("session-a")?.status).toBe("agent-gone");
});

test("a progress frame for a session not yet in the roster is ignored rather than fabricating a partial entry", () => {
	const store = createChatSessions();

	store.applyFrame(buildProgressFrame({ sessionId: "ghost-session" }));

	expect(store.get("ghost-session")).toBeUndefined();
	expect(store.list()).toHaveLength(0);
});

test("unread count starts at zero and increments once per agent-message", () => {
	const store = createChatSessions();
	store.applyFrame(
		buildSessionListFrame([
			{ sessionId: "session-a", agentIdentity: "claude-orchestrator" },
		]),
	);
	expect(store.get("session-a")?.unreadCount).toBe(0);

	store.applyFrame(buildAgentMessageFrame());
	store.applyFrame(buildAgentMessageFrame());

	expect(store.get("session-a")?.unreadCount).toBe(2);
});

test("markSessionRead resets the unread count to zero without touching status", () => {
	const store = createChatSessions();
	store.applyFrame(
		buildSessionListFrame([
			{ sessionId: "session-a", agentIdentity: "claude-orchestrator" },
		]),
	);
	store.applyFrame(buildProgressFrame({ state: "awaiting-input" }));
	store.applyFrame(buildAgentMessageFrame());
	store.applyFrame(buildAgentMessageFrame());
	expect(store.get("session-a")?.unreadCount).toBe(2);

	store.markSessionRead("session-a");

	expect(store.get("session-a")?.unreadCount).toBe(0);
	expect(store.get("session-a")?.status).toBe("awaiting-input");
});

test("session-list replaces the roster wholesale, dropping a session no longer present", () => {
	const store = createChatSessions();
	store.applyFrame(
		buildSessionListFrame([
			{ sessionId: "session-a", agentIdentity: "claude-orchestrator" },
			{ sessionId: "session-b", agentIdentity: "claude-agent" },
		]),
	);
	expect(
		store
			.list()
			.map((e: { sessionId: string }) => e.sessionId)
			.sort(),
	).toEqual(["session-a", "session-b"]);

	store.applyFrame(
		buildSessionListFrame([
			{ sessionId: "session-a", agentIdentity: "claude-orchestrator" },
		]),
	);

	expect(store.list().map((e: { sessionId: string }) => e.sessionId)).toEqual([
		"session-a",
	]);
});

test("a second session-list frame preserves an existing session's status and unread count rather than resetting them", () => {
	const store = createChatSessions();
	store.applyFrame(
		buildSessionListFrame([
			{ sessionId: "session-a", agentIdentity: "claude-orchestrator" },
			{ sessionId: "session-b", agentIdentity: "claude-agent" },
		]),
	);
	store.applyFrame(
		buildProgressFrame({ sessionId: "session-a", state: "awaiting-input" }),
	);
	store.applyFrame(buildAgentMessageFrame({ sessionId: "session-a" }));
	store.applyFrame(buildAgentMessageFrame({ sessionId: "session-a" }));

	store.applyFrame(
		buildSessionListFrame([
			{ sessionId: "session-a", agentIdentity: "claude-orchestrator" },
			{ sessionId: "session-b", agentIdentity: "claude-agent" },
			{ sessionId: "session-c", agentIdentity: "claude-scout" },
		]),
	);

	const entryA = store.get("session-a");
	expect(entryA?.status).toBe("awaiting-input");
	expect(entryA?.unreadCount).toBe(2);
	expect(store.get("session-c")?.status).toBe("unknown");
});

test("preserves workset and role from the session-list entry for grouping downstream", () => {
	const store = createChatSessions();
	store.applyFrame(
		buildSessionListFrame([
			{
				sessionId: "session-a",
				agentIdentity: "claude-orchestrator",
				role: "orchestrator",
				workset: "chat-harness",
			},
		]),
	);

	const entry = store.get("session-a");
	expect(entry?.role).toBe("orchestrator");
	expect(entry?.workset).toBe("chat-harness");
});

test("a session-closed frame removes the session from the roster", () => {
	const store = createChatSessions();
	store.applyFrame(
		buildSessionListFrame([
			{ sessionId: "session-a", agentIdentity: "claude-orchestrator" },
		]),
	);
	expect(store.get("session-a")).toBeDefined();

	store.applyFrame(buildSessionClosedFrame());

	expect(store.get("session-a")).toBeUndefined();
	expect(store.list()).toHaveLength(0);
});
