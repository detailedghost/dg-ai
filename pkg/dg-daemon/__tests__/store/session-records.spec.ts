import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { writeSessionToken, resolveDgPaths } from "@dg/common/node";
import { ChatStore } from "../../src/store";
import {
	cleanupDgHome,
	FILE_ONLY_SEAMS,
	freshDgHome,
} from "../utils/daemon-harness";

const TOKEN = "legacy-session-token-value";

async function withHome(
	run: (paths: ReturnType<typeof resolveDgPaths>) => Promise<void>,
) {
	const dgHome = freshDgHome();
	try {
		await run(resolveDgPaths({ env: { DG_HOME: dgHome } }));
	} finally {
		cleanupDgHome(dgHome);
	}
}

describe("chat sessions in the daemon database", () => {
	it("migrates a session file into an encrypted row and deletes the file", async () => {
		await withHome(async (paths) => {
			writeSessionToken(paths, "legacy-1", {
				sessionId: "legacy-1",
				token: TOKEN,
				cwd: "/work/app",
				agentIdentity: "claude",
			});
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			try {
				expect(existsSync(`${paths.sessionsDir}/legacy-1.json`)).toBe(false);
				const loaded = store.loadSessions();
				expect(loaded.map((session) => session.sessionId)).toEqual(["legacy-1"]);
				expect(loaded[0]?.token).toBe(TOKEN);
				expect(loaded[0]?.agentIdentity).toBe("claude");
				const raw = new Database(paths.dbPath, { readonly: true, strict: true });
				try {
					const row = raw
						.query("SELECT token_ciphertext FROM sessions WHERE id = ?")
						.get("legacy-1") as { token_ciphertext: Uint8Array };
					expect(Buffer.from(row.token_ciphertext).includes(Buffer.from(TOKEN))).toBe(
						false,
					);
				} finally {
					raw.close();
				}
			} finally {
				store.close();
			}
		});
	});

	it("archives a stale session and prunes its message rows when the archive cap is zero", async () => {
		await withHome(async (paths) => {
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			try {
				const now = 1_000;
				store.saveSession({
					sessionId: "live-1",
					token: TOKEN,
					cwd: "/work/app",
					agentIdentity: "claude",
					role: "agent",
					state: "active",
					awaitingAgent: false,
					cliAttached: false,
					createdAt: now,
					lastActivityAt: now,
				});
				store.insertMessage({
					id: "msg-1",
					sessionId: "live-1",
					role: "user",
					body: "keep me until the archive is trimmed",
				});
				store.archiveSession(
					{
						sessionId: "live-1",
						token: TOKEN,
						cwd: "/work/app",
						agentIdentity: "claude",
						role: "agent",
						state: "closed",
						awaitingAgent: false,
						cliAttached: false,
						createdAt: now,
						lastActivityAt: now,
						closedAt: now,
					},
					"expired",
				);
				expect(store.loadSessions()).toEqual([]);
				const pruned = store.pruneArchive(now, { maxRows: 0, ttlMs: 10_000 });
				expect(pruned.sessions).toBe(1);
				expect(pruned.messages).toBe(1);
				expect(store.peekAll("live-1")).toEqual([]);
			} finally {
				store.close();
			}
		});
	});
});
