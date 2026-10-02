import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import { applyConnectionPragmas, resolveDgPaths, runMigrations } from "@dg/common/node";
import { inboxProfile } from "../../../common/__tests__/utils/inbox-fixtures";
import { buildAad, createCipherBox } from "../../src/crypto/envelope";
import { resolveDataKey } from "../../src/crypto/key-resolution";
import { ChatStore, SCHEDULER_SESSION_ID } from "../../src/store";
import { CURRENT_SCHEMA_VERSION, SCHEMA_STEPS } from "../../src/store/schema";
import { cleanupDgHome, FILE_ONLY_SEAMS, freshDgHome, scanFileForBytes } from "../utils/daemon-harness";

async function withHome(run: (paths: ReturnType<typeof resolveDgPaths>) => Promise<void>) {
	const dgHome = freshDgHome();
	try { await run(resolveDgPaths({ env: { DG_HOME: dgHome } })); }
	finally { cleanupDgHome(dgHome); }
}

describe("ChatStore — inbox profiles and auth caches", () => {
	it("persists profiles and isolated provider caches through reopen without exposing cache in summaries", async () => {
		await withHome(async (paths) => {
			const profile = inboxProfile();
			const gmailCache = JSON.stringify({ refresh_token: "fixture-refresh-sensitive-8bc632" });
			const outlookCache = JSON.stringify({ AccessToken: "fixture-outlook-sensitive-837bb1" });
			let store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			try {
				store.setInboxProfile("personal", profile);
				store.setInboxAuthCache("personal", "gmail", gmailCache);
				store.setInboxAuthCache("personal", "outlook", outlookCache);
			} finally { store.close(); }
			store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			try {
				expect(store.getInboxProfile("personal")).toEqual(profile);
				expect(store.getInboxAuthCache("personal", "gmail")).toBe(gmailCache);
				expect(store.getInboxAuthCache("personal", "outlook")).toBe(outlookCache);
				expect(store.getInboxAuthCache("other", "gmail")).toBeNull();
				expect(store.getInboxProfile("missing")).toBeNull();
				expect(store.listInboxProfiles()).toEqual([{ name: "personal", provider: profile.provider }]);
				expect(JSON.stringify(store.listInboxProfiles())).not.toContain(gmailCache);
			} finally { store.close(); }
		});
	});

	it("encrypts profile metadata and OAuth cache before DB/WAL writes, including replacements", async () => {
		await withHome(async (paths) => {
			const accountHint = "private-account-marker-6385c2@example.test";
			const cache = "oauth-cache-sensitive-marker-338f72";
			const updatedCache = `${cache}-replacement`;
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			try {
				store.setInboxProfile("personal", inboxProfile({ accountHint }));
				store.setInboxAuthCache("personal", "gmail", cache);
				store.setInboxAuthCache("personal", "gmail", updatedCache);
				expect(store.getInboxAuthCache("personal", "gmail")).toBe(updatedCache);
				for (const needle of [accountHint, cache, updatedCache]) {
					expect(scanFileForBytes(paths.dbPath, needle)).toBe(false);
					expect(scanFileForBytes(`${paths.dbPath}-wal`, needle)).toBe(false);
				}
			} finally { store.close(); }
			for (const needle of [accountHint, cache, updatedCache]) {
				expect(scanFileForBytes(paths.dbPath, needle)).toBe(false);
				expect(scanFileForBytes(`${paths.dbPath}-wal`, needle)).toBe(false);
			}
		});
	});

	it("refuses invalid profile writes without replacing an existing encrypted profile", async () => {
		await withHome(async (paths) => {
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			try {
				const profile = inboxProfile();
				store.setInboxProfile("personal", profile);
				expect(() => store.setInboxProfile("personal", { provider: "imap" })).toThrow();
				expect(store.getInboxProfile("personal")).toEqual(profile);
			} finally { store.close(); }
		});
	});

	it("migrates actual v8 encrypted messages and jobs without changing their key or decryptability", async () => {
		await withHome(async (paths) => {
			mkdirSync(paths.daemonDir, { recursive: true, mode: 0o700 });
			const raw = new Database(paths.dbPath, { create: true });
			applyConnectionPragmas(raw);
			runMigrations(raw, SCHEMA_STEPS.filter((step) => step.version <= 8));
			const { dataKey, cryptoMeta } = await resolveDataKey({ keyPath: paths.keyPath, mode: "file" });
			const message = { id: "legacy-message", sessionId: "legacy-session", body: "retained encrypted inbox setup" };
			const job = { id: "legacy-job", argv: ["fixture", "encrypted-legacy-arg"] };
			const jobEnc = createCipherBox(dataKey).encryptRecord(JSON.stringify(job.argv), buildAad({ domain: "job-argv", sessionId: SCHEDULER_SESSION_ID, rowId: job.id, formatVersion: cryptoMeta.formatVersion }));
			const enc = createCipherBox(dataKey).encryptRecord(message.body, buildAad({ domain: "message-body", sessionId: message.sessionId, rowId: message.id, formatVersion: cryptoMeta.formatVersion }));
			try {
				raw.run("INSERT INTO crypto_meta VALUES (1, ?, ?, ?, ?)", [cryptoMeta.formatVersion, cryptoMeta.keyId, cryptoMeta.keySource, cryptoMeta.wrappedDataKey]);
				raw.run("INSERT INTO sessions (id, created_at) VALUES (?, ?)", [message.sessionId, new Date().toISOString()]);
				raw.run("INSERT INTO messages (id, session_id, role, created_at, body_ciphertext, body_iv, body_tag) VALUES (?, ?, 'user', ?, ?, ?, ?)", [message.id, message.sessionId, new Date().toISOString(), enc.ciphertext, enc.iv, enc.tag]);
			raw.run("INSERT INTO scheduled_jobs (id, label, created_at, argv_ciphertext, argv_iv, argv_tag, cwd, interval_ms, enabled, next_run_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [job.id, "legacy-job", new Date().toISOString(), jobEnc.ciphertext, jobEnc.iv, jobEnc.tag, "/tmp", 60000, 1, new Date().toISOString()]);
			} finally { raw.close(); }
			const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			try {
				expect(store.userVersion()).toBe(CURRENT_SCHEMA_VERSION);
				expect(store.userVersion()).toBeGreaterThan(8);
				expect(store.getJob(job.id)?.argv).toEqual(job.argv);
				expect(store.cryptoMeta().keyId).toBe(cryptoMeta.keyId);
				expect(store.peekAll(message.sessionId)[0]).toMatchObject({ id: message.id, body: message.body });
				store.setInboxProfile("personal", inboxProfile());
				expect(store.getInboxProfile("personal")).toEqual(inboxProfile());
			} finally { store.close(); }
		});
	});
});
