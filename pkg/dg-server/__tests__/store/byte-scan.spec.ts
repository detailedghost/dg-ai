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

describe("on-disk bytes never carry plaintext content", () => {
	it("keeps a message body out of the db file and its -wal sidecar", async () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			const needle = "NEEDLE-MESSAGE-BODY-7f3a9c";

			store.insertMessage({
				sessionId: "session-scan-1",
				id: "msg-1",
				role: "user",
				body: `hello there ${needle} end`,
			});

			expect(scanFile(`${paths.dbPath}-wal`, needle)).toBe(false);
			store.close();
			expect(scanFile(paths.dbPath, needle)).toBe(false);
			expect(scanFile(`${paths.dbPath}-wal`, needle)).toBe(false);
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("keeps command_invocations argv and captured output out of the db file and its -wal sidecar", async () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			const argvNeedle = "--needle-argv-4b1e2d";
			const outputNeedle = "NEEDLE-STDOUT-9d0c11";

			store.insertCommandInvocation({
				sessionId: "session-scan-1",
				id: "cmd-1",
				argv: ["run", argvNeedle],
				stdout: `output line with ${outputNeedle}`,
				stderr: "",
				truncated: false,
			});

			expect(scanFile(`${paths.dbPath}-wal`, argvNeedle)).toBe(false);
			expect(scanFile(`${paths.dbPath}-wal`, outputNeedle)).toBe(false);
			store.close();
			expect(scanFile(paths.dbPath, argvNeedle)).toBe(false);
			expect(scanFile(paths.dbPath, outputNeedle)).toBe(false);
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("keeps sessionId and seq queryable in plaintext via a raw connection, independent of the Store", async () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);

			const first = store.insertMessage({
				sessionId: "session-query-1",
				id: "msg-a",
				role: "user",
				body: "first",
			});
			const second = store.insertMessage({
				sessionId: "session-query-1",
				id: "msg-b",
				role: "agent",
				body: "second",
			});

			const raw = new Database(paths.dbPath, { readonly: true });
			const rows = raw
				.query(
					"SELECT session_id, seq FROM messages WHERE session_id = ? ORDER BY seq",
				)
				.all("session-query-1") as { session_id: string; seq: number }[];
			raw.close(true);

			expect(rows).toEqual([
				{ session_id: "session-query-1", seq: first.seq },
				{ session_id: "session-query-1", seq: second.seq },
			]);
			store.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});
});
