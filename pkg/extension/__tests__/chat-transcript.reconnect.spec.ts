import { expect, test } from "bun:test";
import { createTestContainer } from "./utils/dom-events";
import { buildAgentMessageFrame } from "./utils/frame-fixtures";

const { createTranscriptView } = await import("@/lib/features/chat-transcript");

test("a message already rendered live is not duplicated when a later history-response backfill includes the same stored record", async () => {
	const container = createTestContainer();
	const view = createTranscriptView(container);

	await view.appendAgentMessage(
		buildAgentMessageFrame({ body: "here is my answer" }),
		"tok",
	);
	view.applyHistory(
		[
			{
				seq: 1,
				id: "msg-1",
				role: "agent",
				body: "here is my answer",
				createdAt: "2026-08-18T00:00:00.000Z",
			},
		],
		"session-a",
		"tok",
	);

	const bodies = Array.from(
		container.querySelectorAll(".chat-transcript__body"),
	).map((n) => n.textContent);
	expect(bodies).toEqual(["here is my answer"]);
});

test("a reconnect's growing history backfill keeps every item in seq order, even when only the newest record is fresh", () => {
	const container = createTestContainer();
	const view = createTranscriptView(container);

	view.applyHistory(
		[
			{ seq: 1, id: "a", role: "user", body: "A", createdAt: "t1" },
			{ seq: 2, id: "b", role: "agent", body: "B", createdAt: "t2" },
		],
		"session-a",
		"tok",
	);
	view.appendUserMessage("LIVE");
	view.applyHistory(
		[
			{ seq: 1, id: "a", role: "user", body: "A", createdAt: "t1" },
			{ seq: 2, id: "b", role: "agent", body: "B", createdAt: "t2" },
			{ seq: 3, id: "c", role: "agent", body: "C", createdAt: "t3" },
		],
		"session-a",
		"tok",
	);

	const bodies = Array.from(
		container.querySelectorAll(".chat-transcript__body"),
	).map((n) => n.textContent);
	expect(bodies).toEqual(["A", "B", "LIVE", "C"]);
});
