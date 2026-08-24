import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { resolveDgPaths } from "@dg/common/node";
import { ChatStore } from "../../src/store";
import {
	cleanupDgHome,
	FILE_ONLY_SEAMS,
	freshDgHome,
	scanFileForBytes as scanFile,
} from "../utils/daemon-harness";

describe("ChatStore.insertStatusEvent", () => {
	it("round-trips a progress state and keeps it out of the db file and its -wal sidecar", async () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);

			store.insertStatusEvent({
				sessionId: "session-status-1",
				state: "awaiting-input",
			});

			expect(scanFile(`${paths.dbPath}-wal`, "awaiting-input")).toBe(false);
			store.close();
			expect(scanFile(paths.dbPath, "awaiting-input")).toBe(false);
			expect(scanFile(`${paths.dbPath}-wal`, "awaiting-input")).toBe(false);
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("reads back the exact state it wrote, in insertion order", async () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			const sessionId = "session-status-2";

			store.insertStatusEvent({ sessionId, state: "running" });
			store.insertStatusEvent({ sessionId, state: "awaiting-input" });
			store.insertStatusEvent({ sessionId, state: "agent-gone" });

			const events = store.peekStatusEvents(sessionId);
			expect(events.map((e: { state: string }) => e.state)).toEqual([
				"running",
				"awaiting-input",
				"agent-gone",
			]);
			expect(events[0].seq).toBeLessThan(events[1].seq);
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("binds AAD to its own row, so a status ciphertext swapped onto a second status row of the same session fails loudly instead of decrypting to garbage", async () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			const sessionId = "session-status-3";

			store.insertStatusEvent({ sessionId, state: "running" });
			store.insertStatusEvent({ sessionId, state: "agent-gone" });
			store.close();

			const raw = new Database(paths.dbPath, { readwrite: true });
			const rows = raw
				.query(
					"SELECT seq, progress_ciphertext, progress_iv, progress_tag FROM status_events WHERE session_id = ? ORDER BY seq",
				)
				.all(sessionId) as {
				seq: number;
				progress_ciphertext: Uint8Array;
				progress_iv: Uint8Array;
				progress_tag: Uint8Array;
			}[];
			expect(rows.length).toBe(2);
			raw.run(
				"UPDATE status_events SET progress_ciphertext = ?, progress_iv = ?, progress_tag = ? WHERE seq = ?",
				[
					rows[1].progress_ciphertext,
					rows[1].progress_iv,
					rows[1].progress_tag,
					rows[0].seq,
				],
			);
			raw.close(true);

			const reopened = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			expect(() => reopened.peekStatusEvents(sessionId)).toThrow();
			reopened.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});
});
