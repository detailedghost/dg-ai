/**
 * ChatStore — the ONLY store of record. Envelope-encrypted SQLite (bun:sqlite,
 * WAL, STRICT tables) behind the ratified surface: open/close, userVersion,
 * cryptoMeta, insertMessage, insertCommandInvocation, claimNext, ack, peekAll.
 */
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import type { ProgressState } from "@dg/common";
import type { DgPaths } from "@dg/common/node";
import { buildAad, type CipherBox, createCipherBox } from "../crypto/envelope";
import {
	type CryptoMetaRow,
	type KeychainBackend,
	type KeyMode,
	resolveDataKey,
} from "../crypto/key-resolution";
import { createKeychainBackendForPlatform } from "../crypto/keychain-backends";
import { applyConnectionPragmas, DEFAULT_BUSY_TIMEOUT_MS } from "./connection";
import { runMigrations } from "./migrations";
import { SCHEMA_STEPS } from "./schema";

const DEFAULT_CLAIM_LEASE_MS = 30_000;
const AAD_MESSAGE_BODY = "message-body";
const AAD_COMMAND_ARGV = "command-argv";
const AAD_COMMAND_STDOUT = "command-stdout";
const AAD_COMMAND_STDERR = "command-stderr";
const AAD_STATUS_PROGRESS = "status-progress";

export type StoreSeams = {
	env?: Record<string, string | undefined>;
	keychain?: KeychainBackend;
};

export type MessageRole = "user" | "agent";

export type InsertMessageInput = {
	sessionId: string;
	id: string;
	role: MessageRole;
	body: string;
	attachmentId?: string;
};

export type InsertCommandInvocationInput = {
	sessionId: string;
	id: string;
	argv: string[];
	stdout: string;
	stderr: string;
	truncated: boolean;
};

export type InsertStatusEventInput = {
	sessionId: string;
	state: ProgressState;
};

export type StatusEvent = {
	seq: number;
	state: ProgressState;
	createdAt: string;
};

export type ClaimedMessage = {
	claimId: string;
	seq: number;
	id: string;
	sessionId: string;
	role: MessageRole;
	body: string;
	createdAt: string;
	attachmentId?: string;
};

/** Cross-slice contract: exactly the history-response.messages[] item shape. */
export type PeekedMessage = {
	seq: number;
	id: string;
	role: MessageRole;
	body: string;
	createdAt: string;
	attachmentId?: string;
};

export type CryptoMetaInfo = {
	formatVersion: number;
	keyId: string;
	keySource: string;
	wrappedDataKey: Buffer;
};

type RawMessageRow = {
	seq: number;
	id: string;
	role: string;
	created_at: string;
	body_ciphertext: Uint8Array;
	body_iv: Uint8Array;
	body_tag: Uint8Array;
	attachment_id: string | null;
};

type RawCryptoMetaRow = {
	format_version: number;
	key_id: string;
	key_source: string;
	wrapped_data_key: Uint8Array;
};

type RawStatusEventRow = {
	seq: number;
	created_at: string;
	progress_ciphertext: Uint8Array;
	progress_iv: Uint8Array;
	progress_tag: Uint8Array;
};

function resolveKeyMode(raw: string | undefined): KeyMode {
	return raw === "file" || raw === "keychain" || raw === "auto" ? raw : "auto";
}

/** chmod to 0700 self-heals a wrongly-permissioned state dir, but AUDIBLY — a silent fix would hide that the db/-wal had been group/world-readable. */
function ensureStateDir(stateDir: string): void {
	if (!existsSync(stateDir)) {
		mkdirSync(stateDir, { recursive: true, mode: 0o700 });
		return;
	}
	const mode = statSync(stateDir).mode & 0o777;
	if (mode !== 0o700) {
		console.warn(
			`dg-server: state directory ${stateDir} had mode ${mode.toString(8)} (expected 0700) — fixing; a permissive directory may have exposed the database or -wal sidecar`,
		);
		chmodSync(stateDir, 0o700);
	}
}

export class ChatStore {
	private constructor(
		private readonly db: Database,
		private readonly cipherBox: CipherBox,
		private readonly meta: CryptoMetaInfo,
		private readonly claimLeaseMs: number,
	) {}

	static async open(
		paths: DgPaths,
		seams: StoreSeams = {},
	): Promise<ChatStore> {
		const env = seams.env ?? process.env;
		ensureStateDir(paths.stateDir);

		const db = new Database(paths.dbPath, {
			strict: true,
			create: true,
			readwrite: true,
		});
		try {
			applyConnectionPragmas(db, DEFAULT_BUSY_TIMEOUT_MS);
			runMigrations(db, SCHEMA_STEPS, { snapshotDir: paths.stateDir });

			// Free crash-during-restart coverage alongside the lease: any claim left
			// in flight from a prior process life is reclaimable immediately on reopen.
			db.run(
				"UPDATE messages SET claim_id = NULL, claimed_at = NULL WHERE delivered_at IS NULL AND claim_id IS NOT NULL",
			);

			const existingRow = db
				.query(
					"SELECT format_version, key_id, key_source, wrapped_data_key FROM crypto_meta WHERE id = 1",
				)
				.get() as RawCryptoMetaRow | null;
			const existing: CryptoMetaRow | undefined = existingRow
				? {
						formatVersion: existingRow.format_version,
						keyId: existingRow.key_id,
						keySource: existingRow.key_source,
						wrappedDataKey: Buffer.from(existingRow.wrapped_data_key),
					}
				: undefined;

			const mode = resolveKeyMode(env.DG_KEY_SOURCE);
			const keychain =
				seams.keychain ?? createKeychainBackendForPlatform(paths.stateDir);

			const resolved = await resolveDataKey({
				existing,
				keyPath: paths.keyPath,
				mode,
				keychain,
			});
			for (const warning of resolved.warnings) {
				console.warn(`dg-server: ${warning}`);
			}

			if (!existingRow) {
				db.run(
					"INSERT INTO crypto_meta (id, format_version, key_id, key_source, wrapped_data_key) VALUES (1, ?, ?, ?, ?)",
					[
						resolved.cryptoMeta.formatVersion,
						resolved.cryptoMeta.keyId,
						resolved.cryptoMeta.keySource,
						resolved.cryptoMeta.wrappedDataKey,
					],
				);
			}

			const claimLeaseMs = env.DG_CLAIM_LEASE_MS
				? Number(env.DG_CLAIM_LEASE_MS)
				: DEFAULT_CLAIM_LEASE_MS;

			return new ChatStore(
				db,
				createCipherBox(resolved.dataKey),
				resolved.cryptoMeta,
				claimLeaseMs,
			);
		} catch (err) {
			db.close(false); // don't mask the original error behind a locked-db throw
			throw err;
		}
	}

	close(): void {
		this.db.close(true);
	}

	userVersion(): number {
		return (
			this.db.query("PRAGMA user_version").get() as { user_version: number }
		).user_version;
	}

	cryptoMeta(): CryptoMetaInfo {
		return { ...this.meta };
	}

	private ensureSessionRow(sessionId: string): void {
		this.db.run(
			"INSERT INTO sessions (id, created_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING",
			[sessionId, new Date().toISOString()],
		);
	}

	private decryptMessageBody(row: RawMessageRow, sessionId: string): string {
		const aad = buildAad({
			domain: AAD_MESSAGE_BODY,
			sessionId,
			rowId: row.id,
			formatVersion: this.meta.formatVersion,
		});
		return this.cipherBox
			.decryptRecord(
				Buffer.from(row.body_ciphertext),
				Buffer.from(row.body_iv),
				Buffer.from(row.body_tag),
				aad,
			)
			.toString("utf8");
	}

	insertMessage(input: InsertMessageInput): { seq: number } {
		this.ensureSessionRow(input.sessionId);
		const aad = buildAad({
			domain: AAD_MESSAGE_BODY,
			sessionId: input.sessionId,
			rowId: input.id,
			formatVersion: this.meta.formatVersion,
		});
		const enc = this.cipherBox.encryptRecord(input.body, aad);
		const createdAt = new Date().toISOString();
		const row = this.db
			.query(
				`INSERT INTO messages (id, session_id, role, created_at, body_ciphertext, body_iv, body_tag, attachment_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				 RETURNING seq`,
			)
			.get(
				input.id,
				input.sessionId,
				input.role,
				createdAt,
				enc.ciphertext,
				enc.iv,
				enc.tag,
				input.attachmentId ?? null,
			) as { seq: number };
		return { seq: row.seq };
	}

	insertCommandInvocation(input: InsertCommandInvocationInput): {
		seq: number;
	} {
		this.ensureSessionRow(input.sessionId);
		const createdAt = new Date().toISOString();
		const formatVersion = this.meta.formatVersion;

		const argvEnc = this.cipherBox.encryptRecord(
			JSON.stringify(input.argv),
			buildAad({
				domain: AAD_COMMAND_ARGV,
				sessionId: input.sessionId,
				rowId: input.id,
				formatVersion,
			}),
		);
		const stdoutEnc = this.cipherBox.encryptRecord(
			input.stdout,
			buildAad({
				domain: AAD_COMMAND_STDOUT,
				sessionId: input.sessionId,
				rowId: input.id,
				formatVersion,
			}),
		);
		const stderrEnc = this.cipherBox.encryptRecord(
			input.stderr,
			buildAad({
				domain: AAD_COMMAND_STDERR,
				sessionId: input.sessionId,
				rowId: input.id,
				formatVersion,
			}),
		);

		const row = this.db
			.query(
				`INSERT INTO command_invocations (
					id, session_id, created_at,
					argv_ciphertext, argv_iv, argv_tag,
					stdout_ciphertext, stdout_iv, stdout_tag,
					stderr_ciphertext, stderr_iv, stderr_tag,
					truncated
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				RETURNING seq`,
			)
			.get(
				input.id,
				input.sessionId,
				createdAt,
				argvEnc.ciphertext,
				argvEnc.iv,
				argvEnc.tag,
				stdoutEnc.ciphertext,
				stdoutEnc.iv,
				stdoutEnc.tag,
				stderrEnc.ciphertext,
				stderrEnc.iv,
				stderrEnc.tag,
				input.truncated ? 1 : 0,
			) as { seq: number };
		return { seq: row.seq };
	}

	insertStatusEvent(input: InsertStatusEventInput): { seq: number } {
		this.ensureSessionRow(input.sessionId);
		const createdAt = new Date().toISOString();
		this.db.run("BEGIN IMMEDIATE");
		try {
			this.db.run(
				`INSERT INTO status_events (
					session_id, created_at, progress_ciphertext, progress_iv, progress_tag
				) VALUES (?, ?, X'', X'', X'')`,
				[input.sessionId, createdAt],
			);
			const row = this.db.query("SELECT last_insert_rowid() AS seq").get() as {
				seq: number;
			};
			const encrypted = this.cipherBox.encryptRecord(
				input.state,
				buildAad({
					domain: AAD_STATUS_PROGRESS,
					sessionId: input.sessionId,
					rowId: String(row.seq),
					formatVersion: this.meta.formatVersion,
				}),
			);
			this.db.run(
				`UPDATE status_events
				 SET progress_ciphertext = ?, progress_iv = ?, progress_tag = ?
				 WHERE seq = ?`,
				[encrypted.ciphertext, encrypted.iv, encrypted.tag, row.seq],
			);
			this.db.run("COMMIT");
			return row;
		} catch (error) {
			try {
				this.db.run("ROLLBACK");
			} catch {
				// Preserve the write-path error if SQLite already ended the transaction.
			}
			throw error;
		}
	}

	peekStatusEvents(sessionId: string): StatusEvent[] {
		const rows = this.db
			.query(
				`SELECT seq, created_at, progress_ciphertext, progress_iv, progress_tag
				 FROM status_events WHERE session_id = ? ORDER BY seq ASC`,
			)
			.all(sessionId) as RawStatusEventRow[];
		return rows.map((row) => ({
			seq: row.seq,
			state: this.cipherBox
				.decryptRecord(
					Buffer.from(row.progress_ciphertext),
					Buffer.from(row.progress_iv),
					Buffer.from(row.progress_tag),
					buildAad({
						domain: AAD_STATUS_PROGRESS,
						sessionId,
						rowId: String(row.seq),
						formatVersion: this.meta.formatVersion,
					}),
				)
				.toString("utf8") as ProgressState,
			createdAt: row.created_at,
		}));
	}

	/**
	 * Single UPDATE...RETURNING claims the oldest un-delivered, un-leased row —
	 * "un-leased" meaning claim_id is NULL or its claimed_at predates the
	 * DG_CLAIM_LEASE_MS cutoff, so a lease expiry is reclaimed in this same
	 * statement with no fourth verb (ratified override of restart-only reset).
	 */
	claimNext(sessionId: string): ClaimedMessage | undefined {
		const claimId = randomUUID();
		const now = Date.now();
		const leaseCutoff = now - this.claimLeaseMs;
		const row = this.db
			.query(
				`UPDATE messages
				 SET claim_id = ?, claimed_at = ?
				 WHERE seq = (
					 SELECT seq FROM messages
					 WHERE session_id = ?
					   AND delivered_at IS NULL
					   AND (claim_id IS NULL OR claimed_at < ?)
					 ORDER BY seq ASC
					 LIMIT 1
				 )
				 RETURNING seq, id, role, created_at, body_ciphertext, body_iv, body_tag, attachment_id`,
			)
			.get(claimId, now, sessionId, leaseCutoff) as RawMessageRow | null;

		if (!row) return undefined;

		return {
			claimId,
			seq: row.seq,
			id: row.id,
			sessionId,
			role: row.role as MessageRole,
			body: this.decryptMessageBody(row, sessionId),
			createdAt: row.created_at,
			attachmentId: row.attachment_id ?? undefined,
		};
	}

	/** Only the matching claimId acks — a stale claimant from before a lease reclaim must not satisfy the new one. */
	ack(sessionId: string, claimId: string): boolean {
		const row = this.db
			.query(
				`UPDATE messages
				 SET delivered_at = ?
				 WHERE session_id = ? AND claim_id = ? AND delivered_at IS NULL
				 RETURNING seq`,
			)
			.get(Date.now(), sessionId, claimId) as { seq: number } | null;
		return row !== null;
	}

	peekAll(sessionId: string): PeekedMessage[] {
		const rows = this.db
			.query(
				`SELECT seq, id, role, created_at, body_ciphertext, body_iv, body_tag, attachment_id
				 FROM messages WHERE session_id = ? ORDER BY seq ASC`,
			)
			.all(sessionId) as RawMessageRow[];
		return rows.map((row) => ({
			seq: row.seq,
			id: row.id,
			role: row.role as MessageRole,
			body: this.decryptMessageBody(row, sessionId),
			createdAt: row.created_at,
			attachmentId: row.attachment_id ?? undefined,
		}));
	}
}
