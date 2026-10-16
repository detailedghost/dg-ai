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
				expect(loaded[0]?.role).toBe("agent");
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

	it("keeps an orchestrator role written on a legacy session file", async () => {
		await withHome(async (paths) => {
			writeSessionToken(paths, "orch-1", {
				sessionId: "orch-1",
				token: TOKEN,
				cwd: "/work/app",
				agentIdentity: "claude",
				role: "orchestrator",
			});
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			try {
				expect(store.loadSessions()[0]?.role).toBe("orchestrator");
			} finally {
				store.close();
			}
		});
	});

	it("two stores pruning the same database delete each archived row once", async () => {
		await withHome(async (paths) => {
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			const now = 5_000;
			try {
				for (const id of ["a", "b", "c"]) {
					store.saveSession({
						sessionId: id,
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
						id: `msg-${id}`,
						sessionId: id,
						role: "user",
						body: `body ${id}`,
					});
					store.archiveSession(
						{
							sessionId: id,
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
				}
			} finally {
				store.close();
			}

			const dgHome = paths.stateDir;
			const worker = new URL("./prune-worker.ts", import.meta.url).pathname;
			const run = () =>
				Bun.spawn([process.execPath, worker], {
					env: { ...process.env, DG_HOME: dgHome, DG_KEY_SOURCE: "file" },
					stdout: "pipe",
					stderr: "pipe",
				});
			const [left, right] = await Promise.all([run(), run()]);
			const [leftOut, rightOut, leftErr, rightErr, leftCode, rightCode] =
				await Promise.all([
					new Response(left.stdout).text(),
					new Response(right.stdout).text(),
					new Response(left.stderr).text(),
					new Response(right.stderr).text(),
					left.exited,
					right.exited,
				]);
			expect(leftCode, leftErr).toBe(0);
			expect(rightCode, rightErr).toBe(0);
			const counts = [leftOut, rightOut].map(
				(text) => JSON.parse(text) as { sessions: number; messages: number },
			);
			expect(counts.reduce((sum, count) => sum + count.sessions, 0)).toBe(3);
			expect(counts.reduce((sum, count) => sum + count.messages, 0)).toBe(3);

			const check = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			try {
				expect(check.loadSessions()).toEqual([]);
				expect(check.peekAll("a")).toEqual([]);
			} finally {
				check.close();
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
