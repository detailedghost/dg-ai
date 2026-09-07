import { describe, expect, it, spyOn } from "bun:test";
import { CHAT_MAX_PAYLOAD_BYTES, fitHistoryPage } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import type { CipherBox } from "../../src/crypto/envelope";
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

describe("ChatStore.peekTailForHistory", () => {
	it("matches fitHistoryPage(peekTail(...)) even when message sizes vary", async () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			for (let i = 0; i < 40; i++) {
				store.insertMessage({
					sessionId: SESSION_ID,
					id: `mixed-${i}`,
					role: i % 2 === 0 ? "user" : "agent",
					body: "x".repeat(i % 2 === 0 ? 45_000 : 15_000),
				});
			}

			const overhead = 37;
			const viaOldPath = fitHistoryPage(
				store.peekTail(SESSION_ID, HISTORY_TAIL_ROW_LIMIT),
				overhead,
			);
			const viaNewPath = store.peekTailForHistory(
				SESSION_ID,
				overhead,
				HISTORY_TAIL_ROW_LIMIT,
			);

			expect(viaNewPath).toEqual(viaOldPath);
			expect(viaNewPath.length).toBeGreaterThan(0);
			expect(viaNewPath.length).toBeLessThan(40);
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("decrypts only the rows it ends up keeping, plus the one that overflowed the budget — never the whole tail", async () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			const total = 50;
			for (let i = 0; i < total; i++) {
				store.insertMessage({
					sessionId: SESSION_ID,
					id: `big-${i}`,
					role: "user",
					body: "x".repeat(25_000),
				});
			}

			const expected = fitHistoryPage(store.peekTail(SESSION_ID, total), 0);
			expect(expected.length).toBeGreaterThan(0);
			expect(expected.length).toBeLessThan(total);

			const cipherBox = (store as unknown as { cipherBox: CipherBox })
				.cipherBox;
			const decryptSpy = spyOn(cipherBox, "decryptRecord");
			const budgeted = store.peekTailForHistory(
				SESSION_ID,
				0,
				HISTORY_TAIL_ROW_LIMIT,
			);
			const decryptCalls = decryptSpy.mock.calls.length;
			decryptSpy.mockRestore();

			expect(budgeted).toEqual(expected);
			expect(decryptCalls).toBe(expected.length + 1);
			expect(decryptCalls).toBeLessThan(total);

			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});
});
