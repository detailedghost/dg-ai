/**
 * Regression coverage for applyHistory's reconnect path: a stored record
 * matching content already rendered live must not duplicate it, and a
 * growing backfill (repeat applyHistory calls) must keep every item in
 * seq order rather than always inserting new-only items at the front.
 */

import { expect, test } from "bun:test";
import { CHAT_PROTOCOL_VERSION } from "@dg/common";
import { Window } from "happy-dom";

const { createTranscriptView } = await import("@/lib/features/chat-transcript");

function newContainer(): HTMLElement {
	const window = new Window();
	const document = window.document as unknown as Document;
	return document.createElement("div") as unknown as HTMLElement;
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

test("a message already rendered live is not duplicated when a later history-response backfill includes the same stored record", async () => {
	const container = newContainer();
	const view = createTranscriptView(container);

	await view.appendAgentMessage(
		buildAgentMessageFrame({ body: "here is my answer" }),
		"tok",
	);
	view.applyHistory([
		{
			seq: 1,
			id: "msg-1",
			role: "agent",
			body: "here is my answer",
			createdAt: "2026-08-18T00:00:00.000Z",
		},
	]);

	const bodies = Array.from(
		container.querySelectorAll(".chat-transcript__body"),
	).map((n) => n.textContent);
	expect(bodies).toEqual(["here is my answer"]);
});

test("a reconnect's growing history backfill keeps every item in seq order, even when only the newest record is fresh", () => {
	const container = newContainer();
	const view = createTranscriptView(container);

	view.applyHistory([
		{ seq: 1, id: "a", role: "user", body: "A", createdAt: "t1" },
		{ seq: 2, id: "b", role: "agent", body: "B", createdAt: "t2" },
	]);
	view.appendUserMessage("LIVE");
	// Reconnect re-requests the full backfill: a and b are already rendered,
	// c is the only genuinely new record.
	view.applyHistory([
		{ seq: 1, id: "a", role: "user", body: "A", createdAt: "t1" },
		{ seq: 2, id: "b", role: "agent", body: "B", createdAt: "t2" },
		{ seq: 3, id: "c", role: "agent", body: "C", createdAt: "t3" },
	]);

	const bodies = Array.from(
		container.querySelectorAll(".chat-transcript__body"),
	).map((n) => n.textContent);
	expect(bodies).toEqual(["A", "B", "LIVE", "C"]);
});
