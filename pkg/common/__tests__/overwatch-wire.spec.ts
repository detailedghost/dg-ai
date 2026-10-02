import { describe, expect, it } from "bun:test";
import {
	CHAT_PROTOCOL_VERSION,
	type CliFrame,
	type CliOverwatchSnapshotResult,
	type OverwatchBoard,
	type OverwatchStage,
	validateChatFrame,
	validateOverwatchAction,
	validateOverwatchLane,
} from "../src/index";

function buildLane(overrides: Record<string, unknown> = {}) {
	return {
		chat: "print",
		task: "Prepare launch collateral",
		stage: "review",
		mr: "!298",
		eta: "20m",
		next: "Approve copy",
		url: "https://claude.ai/code/session-123",
		kind: "chat",
		publisher: "print-agent",
		updatedAt: "2026-10-02T15:00:00.000Z",
		...overrides,
	};
}

function buildBoard(overrides: Record<string, unknown> = {}) {
	return {
		goLive: "2026-10-24T14:00:00.000Z",
		goNoGo: "2026-10-17T14:00:00.000Z",
		lanes: [buildLane()],
		merges: [
			{
				mr: "!297",
				title: "Add launch checklist",
				at: "2026-10-02T14:00:00.000Z",
			},
		],
		...overrides,
	};
}

function buildStateFrame(overrides: Record<string, unknown> = {}) {
	return {
		type: "overwatch-state",
		sessionId: "__overwatch__",
		protocolVersion: CHAT_PROTOCOL_VERSION,
		board: buildBoard(),
		...overrides,
	};
}

function buildOpenFrame(overrides: Record<string, unknown> = {}) {
	return {
		type: "overwatch-open",
		sessionId: "__overwatch__",
		protocolVersion: CHAT_PROTOCOL_VERSION,
		...overrides,
	};
}

describe("Overwatch chat frames", () => {
	it("accepts a well-formed overwatch-state frame", () => {
		expect(validateChatFrame(buildStateFrame()).type).toBe("overwatch-state");
	});

	it("rejects an overwatch-state frame with an invalid board", () => {
		expect(() =>
			validateChatFrame(
				buildStateFrame({ board: buildBoard({ lanes: "not-an-array" }) }),
			),
		).toThrow("board.lanes");
	});

	it("accepts a well-formed overwatch-open frame", () => {
		expect(validateChatFrame(buildOpenFrame()).type).toBe("overwatch-open");
	});

	it("rejects a token on the outbound-only overwatch-open frame", () => {
		expect(() =>
			validateChatFrame(buildOpenFrame({ token: "not-allowed" })),
		).toThrow("token");
	});
});

describe("validateOverwatchLane", () => {
	it("accepts every Overwatch stage", () => {
		const stages = [
			"review",
			"ci",
			"e2e",
			"merge",
			"done",
		] satisfies OverwatchStage[];
		for (const stage of stages) {
			expect(validateOverwatchLane(buildLane({ stage })).stage).toBe(stage);
		}
	});

	it("rejects an unknown stage and names the field", () => {
		expect(() => validateOverwatchLane(buildLane({ stage: "deploy" }))).toThrow(
			"overwatch lane.stage",
		);
	});

	it.each([
		["chat", "x".repeat(41)],
		["task", "x".repeat(81)],
	])("rejects an oversized %s and names the field", (field, value) => {
		expect(() =>
			validateOverwatchLane(buildLane({ [field]: value })),
		).toThrow(`overwatch lane.${field}`);
	});

	it("rejects a non-Claude URL and names the field", () => {
		expect(() =>
			validateOverwatchLane(buildLane({ url: "https://example.com/chat" })),
		).toThrow("overwatch lane.url");
	});
});

describe("validateOverwatchAction", () => {
	it.each(["reply", "approve", "reject"])(
		"accepts a well-formed %s action",
		(action) => {
			const value = {
				chat: "print",
				action,
				...(action === "reject" ? { note: "Please revise the copy" } : {}),
			};
			expect(validateOverwatchAction(value)).toEqual(value);
		},
	);

	it("rejects a reject action without a note and names the field", () => {
		expect(() =>
			validateOverwatchAction({ chat: "print", action: "reject" }),
		).toThrow("overwatch action.note");
	});

	it("rejects an oversized note and names the field", () => {
		expect(() =>
			validateOverwatchAction({
				chat: "print",
				action: "reply",
				note: "x".repeat(2_001),
			}),
		).toThrow("overwatch action.note");
	});
});

describe("Overwatch CLI frame types", () => {
	it("represent every request frame and the snapshot result", () => {
		const frames = [
			{
				type: "cli-overwatch-set",
				chat: "print",
				task: "Prepare launch collateral",
				stage: "e2e",
				mr: "!298",
				eta: "20m",
				next: "Approve copy",
				url: "https://claude.ai/code/session-123",
				kind: "chat",
			},
			{ type: "cli-overwatch-remove", chat: "print" },
			{
				type: "cli-overwatch-merged",
				mr: "!297",
				title: "Add launch checklist",
			},
			{
				type: "cli-overwatch-launch",
				goLive: "2026-10-24T14:00:00.000Z",
				goNoGo: "2026-10-17T14:00:00.000Z",
			},
			{ type: "cli-overwatch-open" },
			{ type: "cli-overwatch-snapshot" },
		] satisfies CliFrame[];
		const result = {
			type: "cli-overwatch-snapshot-result",
			board: buildBoard() as OverwatchBoard,
		} satisfies CliOverwatchSnapshotResult;

		expect(frames.map((frame) => frame.type)).toEqual([
			"cli-overwatch-set",
			"cli-overwatch-remove",
			"cli-overwatch-merged",
			"cli-overwatch-launch",
			"cli-overwatch-open",
			"cli-overwatch-snapshot",
		]);
		expect(result.type).toBe("cli-overwatch-snapshot-result");
	});
});
