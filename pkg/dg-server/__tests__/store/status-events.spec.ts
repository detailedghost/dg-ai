/**
 * Slice 3 left status_events' write-path OWED to slice 7 (Code Structure:
 * "Encryption write-paths owned by later slices" — status_events progress
 * text, its own AAD domain tag). Mirrors byte-scan.spec.ts's established
 * scan-before-and-after-close technique.
 *
 * [SPEC] ASSUMED: ChatStore.insertStatusEvent({sessionId, state}) -> {seq}
 * and peekStatusEvents(sessionId) -> {seq, state, createdAt}[] are RED-stage
 * inventions — the ratified store surface (plan.md's Layer-2 ratification)
 * only lists insertMessage/insertCommandInvocation/claimNext/ack/peekAll.
 * Domain tag "status-progress" is likewise invented. See deferrals.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolveDgPaths } from "@dg/common/node";
import { ChatStore } from "../../src/store";
import { cleanupDgHome, freshDgHome } from "../utils/daemon-harness";

const FILE_ONLY_SEAMS = { env: { DG_KEY_SOURCE: "file" } };

function scanFile(path: string, needle: string): boolean {
	if (!existsSync(path)) return false;
	return readFileSync(path).includes(Buffer.from(needle, "utf8"));
}

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

			// "awaiting-input" itself is the plaintext needle here — if it were
			// stored unencrypted it would appear verbatim in the raw bytes.
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

			// Swap the two rows' ciphertext directly on disk (same session, different
			// seq) — AAD binds rowId, so this must not decrypt cleanly.
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
