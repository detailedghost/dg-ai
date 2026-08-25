import { describe, expect, it } from "bun:test";
import { CHAT_MAX_PAYLOAD_BYTES, fitHistoryPage } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import { HISTORY_TAIL_ROW_LIMIT } from "../../src/server/frame-handlers";
import { ChatStore, type PeekedMessage } from "../../src/store";
import {
	cleanupDgHome,
	FILE_ONLY_SEAMS,
	freshDgHome,
} from "../utils/daemon-harness";

const SESSION_ID = "session-history-tail";

function minimalMessage(seq: number): PeekedMessage {
	return {
		seq,
		id: "a",
		role: "user",
		body: "",
		createdAt: "2024-01-01T00:00:00.000Z",
	};
}

describe("HISTORY_TAIL_ROW_LIMIT", () => {
	it("is large enough that fitHistoryPage never needs a message older than the tail window, even for the smallest possible messages", () => {
		const total = HISTORY_TAIL_ROW_LIMIT + 500;
		const all: PeekedMessage[] = [];
		for (let seq = 1; seq <= total; seq++) all.push(minimalMessage(seq));

		const fromFullHistory = fitHistoryPage(all, 0);
		const fromTailWindow = fitHistoryPage(
			all.slice(-HISTORY_TAIL_ROW_LIMIT),
			0,
		);

		expect(fromTailWindow).toEqual(fromFullHistory);
		expect(fromFullHistory.length).toBeLessThanOrEqual(HISTORY_TAIL_ROW_LIMIT);
		expect(fromFullHistory.length).toBeGreaterThan(0);
	});

	it("stays below CHAT_MAX_PAYLOAD_BYTES worth of rows — a sane, non-runaway ceiling", () => {
		expect(HISTORY_TAIL_ROW_LIMIT).toBeLessThan(CHAT_MAX_PAYLOAD_BYTES);
		expect(HISTORY_TAIL_ROW_LIMIT).toBeGreaterThan(1000);
	});
});

describe("ChatStore.peekTail", () => {
	it("returns the last `limit` messages in ascending seq order, matching the tail of peekAll", async () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			for (let i = 0; i < 20; i++) {
				store.insertMessage({
					sessionId: SESSION_ID,
					id: `msg-${i}`,
					role: "user",
					body: `body-${i}`,
				});
			}

			const tail = store.peekTail(SESSION_ID, 5);
			const expected = store.peekAll(SESSION_ID).slice(-5);

			expect(tail).toEqual(expected);
			expect(tail.map((m) => m.id)).toEqual([
				"msg-15",
				"msg-16",
				"msg-17",
				"msg-18",
				"msg-19",
			]);
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("returns every message, unchanged, when the limit exceeds the session's total", async () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			for (let i = 0; i < 3; i++) {
				store.insertMessage({
					sessionId: SESSION_ID,
					id: `msg-${i}`,
					role: "agent",
					body: `body-${i}`,
				});
			}

			expect(store.peekTail(SESSION_ID, 1000)).toEqual(
				store.peekAll(SESSION_ID),
			);
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});
});
