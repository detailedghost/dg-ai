import { Database } from "bun:sqlite";
import { createHmac, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, statSync } from "node:fs";
import {
	AssetTooLargeError,
	applyOverwatchLaneUpdate,
	CHAT_MAX_ASSET_BYTES,
	CHAT_MAX_PAYLOAD_BYTES,
	type CommandEntry,
	describeError,
	historyItemCost,
	OVERWATCH_SESSION_ID,
	OVERWATCH_MAX_MERGES,
	type OverwatchBoard,
	type OverwatchLane,
	type OverwatchLaneUpdate,
	type OverwatchMerge,
	type ProgressState,
} from "@dg/common";
import {
	applyConnectionPragmas,
	DEFAULT_BUSY_TIMEOUT_MS,
	type DgPaths,
	ensurePrivateDir,
	readSchemaVersion,
	runMigrations,
} from "@dg/common/node";
import {
	buildAad,
	type CipherBox,
	type CipherEnvelope,
	createCipherBox,
} from "../crypto/envelope";
import {
	type CryptoMetaRow,
	type KeychainBackend,
	type KeyMode,
	resolveDataKey,
} from "../crypto/key-resolution";
import { createKeychainBackendForPlatform } from "../crypto/keychain-backends";
import { nextCronRun } from "../jobs/cron";
import { SESSION_MAX_ACTIVE_DEFAULT } from "../session/limits";
import { readEnvNumber } from "../utils/env";
import { SCHEMA_STEPS } from "./schema";

const DEFAULT_CLAIM_LEASE_MS = 30_000;
const HISTORY_TAIL_BATCH_ROWS = 200;
const AAD_MESSAGE_BODY = "message-body";
const AAD_COMMAND_ARGV = "command-argv";
const AAD_COMMAND_STDOUT = "command-stdout";
const AAD_COMMAND_STDERR = "command-stderr";
const AAD_STATUS_PROGRESS = "status-progress";
const AAD_COMMAND_MANIFEST = "command-manifest";
const AAD_SUBAGENT_LIST = "subagent-list";
const AAD_ASSET_FILENAME = "asset-filename";
const AAD_ASSET_BYTES = "asset-bytes";
const AAD_AGENT_MESSAGE_BODY = "agent-message-body";
const AAD_JOB_ARGV = "job-argv";
const AAD_JOB_ERROR = "job-error";
const AAD_JOB_STDERR = "job-stderr";
const AAD_FEED_TITLE = "feed-title";
const AAD_FEED_META = "feed-meta";
const AAD_FEED_URL = "feed-url";
const AAD_OVERWATCH_CHAT = "overwatch-chat";
const AAD_OVERWATCH_TASK = "overwatch-task";
const AAD_OVERWATCH_MR = "overwatch-mr";
const AAD_OVERWATCH_ETA = "overwatch-eta";
const AAD_OVERWATCH_NEXT = "overwatch-next";
const AAD_OVERWATCH_URL = "overwatch-url";
const AAD_OVERWATCH_PUBLISHER = "overwatch-publisher";
const AAD_OVERWATCH_MERGE_MR = "overwatch-merge-mr";
const AAD_OVERWATCH_MERGE_TITLE = "overwatch-merge-title";
const AAD_OVERWATCH_GO_LIVE = "overwatch-go-live";
const AAD_OVERWATCH_GO_NO_GO = "overwatch-go-no-go";
const AAD_ASSET_BYTES_FORMAT_VERSION = 2;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const AGENT_MESSAGE_RETENTION_DAYS = 7;

export const MESSAGE_RETENTION_ROW_LIMIT = 20_000;

export const FEED_ITEM_RETENTION_ROW_LIMIT = 2_000;

/** Session id every scheduler-owned row is stored under. */
export const SCHEDULER_SESSION_ID = "__scheduler__";

export const DEFAULT_FEED_PAGE_LIMIT = 200;

const FEED_INSERT_CHUNK = 250;

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
	subagentName?: string;
};

export type InsertCommandInvocationInput = {
	sessionId: string;
	id: string;
	argv: string[];
	stdout: string;
	stderr: string;
	truncated: boolean;
	label?: string;
};

export type UpdateCommandInvocationResultInput = {
	seq: number;
	sessionId: string;
	id: string;
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

export type InsertAgentMessageInput = {
	senderSessionId: string;
	senderIdentity: string;
	recipientIdentity: string;
	id: string;
	body: string;
};

export type ClaimedAgentMessage = {
	claimId: string;
	seq: number;
	id: string;
	role: "agent";
	from: string;
	to: string;
	body: string;
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
	subagentName?: string;
};

export type PeekedMessage = {
	seq: number;
	id: string;
	role: MessageRole;
	body: string;
	createdAt: string;
	attachmentId?: string;
	subagentName?: string;
};

export type AssetState = "active" | "deleted";

export type InsertAssetInput = {
	sessionId: string;
	id: string;
	filename: string;
	contentType: string;
	byteLength: number;
};

export type AssetRow = {
	id: string;
	sessionId: string;
	filename: string;
	contentType: string;
	byteLength: number;
	state: AssetState;
};

export type ScheduledJob = {
	id: string;
	label: string;
	argv: string[];
	cwd: string;
	intervalMs?: number;
	cronExpr?: string;
	enabled: boolean;
	createdAt: string;
	nextRunAt: string;
	notifyIdentity?: string;
	lastRunAt?: string;
	lastExitCode?: number;
	lastError?: string;
	lastStderr?: string;
};

/** What `GET /jobs` returns — `ScheduledJob` minus argv and stderr, so listing jobs never decrypts either. */
export type JobSummary = {
	id: string;
	label: string;
	intervalMs?: number;
	cronExpr?: string;
	enabled: boolean;
	nextRunAt: string;
	notifyIdentity?: string;
	lastRunAt?: string;
	lastExitCode?: number;
	lastError?: string;
};

export type InsertJobInput = {
	label: string;
	argv: string[];
	cwd: string;
	intervalMs?: number;
	cronExpr?: string;
	notifyIdentity?: string;
	enabled?: boolean;
	nextRunAt?: string;
};

export type RecordJobRunInput = {
	jobId: string;
	ranAt: Date;
	exitCode: number;
	error?: string;
	stderr?: string;
};

export type FeedItemInput = {
	fingerprint: string;
	title: string;
	meta?: string;
	url?: string;
};

export type FeedItem = {
	id: string;
	jobId: string;
	fingerprint: string;
	createdAt: string;
	title: string;
	meta?: string;
	url?: string;
	readAt?: string;
};

export type InsertFeedItemsResult = {
	inserted: FeedItemInput[];
	duplicates: number;
};

export type ListFeedItemsOptions = {
	jobId?: string;
	unreadOnly?: boolean;
	limit?: number;
};

export type UpsertLaneInput = OverwatchLaneUpdate & {
	publisher: string;
};

export type AddMergeInput = Omit<OverwatchMerge, "at">;

export type SetLaunchInput = Pick<OverwatchBoard, "goLive" | "goNoGo"> & {
	goLive: string;
};

export type CryptoMetaInfo = {
	formatVersion: number;
	keyId: string;
	keySource: string;
	wrappedDataKey: Buffer;
};

type ChatStoreDependencies = {
	db: Database;
	cipherBox: CipherBox;
	blindIndexKey: Buffer;
	meta: CryptoMetaInfo;
	claimLeaseMs: number;
};

type EncryptedOverwatchValue = {
	ciphertext: Uint8Array;
	iv: Uint8Array;
	tag: Uint8Array;
};

type OptionalEncryptedOverwatchValue = {
	ciphertext: Uint8Array | null;
	iv: Uint8Array | null;
	tag: Uint8Array | null;
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
	subagent_name: string | null;
};

type RawAgentMessageRow = {
	seq: number;
	id: string;
	sender_identity: string;
	recipient_identity: string;
	created_at: string;
	body_ciphertext: Uint8Array;
	body_iv: Uint8Array;
	body_tag: Uint8Array;
};

type RawCryptoMetaRow = {
	format_version: number;
	key_id: string;
	key_source: string;
	wrapped_data_key: Uint8Array;
};

type RawAssetRow = {
	id: string;
	session_id: string;
	filename_ciphertext: Uint8Array;
	filename_iv: Uint8Array;
	filename_tag: Uint8Array;
	content_type: string;
	byte_length: number;
	state: string;
};

type RawJobRow = {
	id: string;
	label: string;
	created_at: string;
	argv_ciphertext: Uint8Array;
	argv_iv: Uint8Array;
	argv_tag: Uint8Array;
	cwd: string;
	interval_ms: number | null;
	cron_expr: string | null;
	enabled: number;
	notify_identity: string | null;
	last_run_at: string | null;
	next_run_at: string;
	last_exit_code: number | null;
	last_error_ciphertext: Uint8Array | null;
	last_error_iv: Uint8Array | null;
	last_error_tag: Uint8Array | null;
	last_stderr_ciphertext: Uint8Array | null;
	last_stderr_iv: Uint8Array | null;
	last_stderr_tag: Uint8Array | null;
};

type RawJobSummaryRow = {
	id: string;
	label: string;
	interval_ms: number | null;
	cron_expr: string | null;
	enabled: number;
	notify_identity: string | null;
	last_run_at: string | null;
	next_run_at: string;
	last_exit_code: number | null;
	last_error_ciphertext: Uint8Array | null;
	last_error_iv: Uint8Array | null;
	last_error_tag: Uint8Array | null;
};

const JOB_SUMMARY_SELECTION =
	"id, label, interval_ms, cron_expr, enabled, notify_identity, last_run_at, next_run_at, last_exit_code, last_error_ciphertext, last_error_iv, last_error_tag";

type RawFeedItemRow = {
	id: string;
	job_id: string;
	fingerprint: string;
	created_at: string;
	title_ciphertext: Uint8Array;
	title_iv: Uint8Array;
	title_tag: Uint8Array;
	meta_ciphertext: Uint8Array | null;
	meta_iv: Uint8Array | null;
	meta_tag: Uint8Array | null;
	url_ciphertext: Uint8Array | null;
	url_iv: Uint8Array | null;
	url_tag: Uint8Array | null;
	read_at: string | null;
};

type RawOverwatchLaneRow = {
	chat_key: string;
	chat_ciphertext: Uint8Array;
	chat_iv: Uint8Array;
	chat_tag: Uint8Array;
	task_ciphertext: Uint8Array;
	task_iv: Uint8Array;
	task_tag: Uint8Array;
	stage: OverwatchLane["stage"];
	mr_ciphertext: Uint8Array | null;
	mr_iv: Uint8Array | null;
	mr_tag: Uint8Array | null;
	eta_ciphertext: Uint8Array | null;
	eta_iv: Uint8Array | null;
	eta_tag: Uint8Array | null;
	next_ciphertext: Uint8Array | null;
	next_iv: Uint8Array | null;
	next_tag: Uint8Array | null;
	url_ciphertext: Uint8Array | null;
	url_iv: Uint8Array | null;
	url_tag: Uint8Array | null;
	kind: OverwatchLane["kind"];
	publisher_ciphertext: Uint8Array;
	publisher_iv: Uint8Array;
	publisher_tag: Uint8Array;
	updated_at: string;
};

type RawOverwatchMergeRow = {
	id: string;
	mr_ciphertext: Uint8Array;
	mr_iv: Uint8Array;
	mr_tag: Uint8Array;
	title_ciphertext: Uint8Array;
	title_iv: Uint8Array;
	title_tag: Uint8Array;
	at: string;
};

type RawOverwatchSettingsRow = {
	go_live_ciphertext: Uint8Array | null;
	go_live_iv: Uint8Array | null;
	go_live_tag: Uint8Array | null;
	go_no_go_ciphertext: Uint8Array | null;
	go_no_go_iv: Uint8Array | null;
	go_no_go_tag: Uint8Array | null;
};

type RawStatusEventRow = {
	seq: number;
	created_at: string;
	progress_ciphertext: Uint8Array;
	progress_iv: Uint8Array;
	progress_tag: Uint8Array;
};

type CommandManifestRow = {
	commands_ciphertext: Uint8Array;
	commands_iv: Uint8Array;
	commands_tag: Uint8Array;
	subagents_ciphertext: Uint8Array;
	subagents_iv: Uint8Array;
	subagents_tag: Uint8Array;
};

const MESSAGE_SELECTION =
	"seq, id, role, created_at, body_ciphertext, body_iv, body_tag, attachment_id, subagent_name";

const AGENT_MESSAGE_SELECTION =
	"seq, id, sender_identity, recipient_identity, created_at, body_ciphertext, body_iv, body_tag";

const CLAIMABLE_TABLES = ["messages", "agent_messages"] as const;

function claimSql(table: string, filter: string, selection: string): string {
	return `UPDATE ${table}
		SET claim_id = $claimId, claimed_at = $now
		WHERE seq = (
			SELECT seq FROM ${table}
			WHERE ${filter}
			  AND delivered_at IS NULL
			  AND (claim_id IS NULL OR claimed_at < $leaseCutoff)
			ORDER BY seq ASC
			LIMIT 1
		)
		RETURNING ${selection}`;
}

function ackSql(table: string, filter: string): string {
	return `UPDATE ${table}
		SET delivered_at = $now
		WHERE ${filter} AND claim_id = $claimId AND delivered_at IS NULL
		RETURNING seq`;
}

export const MESSAGE_CLAIM_SQL = claimSql(
	"messages",
	"session_id = $sessionId AND role = 'user'",
	MESSAGE_SELECTION,
);
export const MESSAGE_ACK_SQL = ackSql("messages", "session_id = $sessionId");
export const AGENT_MESSAGE_CLAIM_SQL = claimSql(
	"agent_messages",
	"recipient_identity = $identity AND sender_session_id <> $sessionId",
	AGENT_MESSAGE_SELECTION,
);
export const AGENT_MESSAGE_ACK_SQL = ackSql(
	"agent_messages",
	"recipient_identity = $identity",
);

function resolveKeyMode(raw: string | undefined): KeyMode {
	return raw === "file" || raw === "keychain" || raw === "auto" ? raw : "auto";
}

function computeNextRunAt(job: ScheduledJob, ranAt: Date): Date {
	if (job.cronExpr) return nextCronRun(job.cronExpr, ranAt);
	if (job.intervalMs === undefined) {
		throw new Error(
			`job ${job.id} has neither an interval nor a cron expression`,
		);
	}
	return new Date(ranAt.getTime() + job.intervalMs);
}

function ensureDaemonDir(daemonDir: string): void {
	if (!existsSync(daemonDir)) {
		ensurePrivateDir(daemonDir);
		return;
	}
	const mode = statSync(daemonDir).mode & 0o777;
	if (mode !== 0o700) {
		console.warn(
			`dg-daemon: daemon directory ${daemonDir} had mode ${mode.toString(8)} (expected 0700) — fixing; a permissive directory may have exposed the database or -wal sidecar`,
		);
		chmodSync(daemonDir, 0o700);
	}
}

/** Emitted after a message lands in `messages` or `agent_messages`, so a blocked `cli-recv` can wake without polling. */
export const CHAT_STORE_MESSAGE_EVENT = "message";

export class ChatStore extends EventEmitter {
	private readonly db: Database;
	private readonly cipherBox: CipherBox;
	private readonly blindIndexKey: Buffer;
	private readonly meta: CryptoMetaInfo;
	private readonly claimLeaseMs: number;

	private constructor(dependencies: ChatStoreDependencies) {
		super();
		this.db = dependencies.db;
		this.cipherBox = dependencies.cipherBox;
		this.blindIndexKey = dependencies.blindIndexKey;
		this.meta = dependencies.meta;
		this.claimLeaseMs = dependencies.claimLeaseMs;
		this.setMaxListeners(SESSION_MAX_ACTIVE_DEFAULT);
	}

	static async open(
		paths: DgPaths,
		seams: StoreSeams = {},
	): Promise<ChatStore> {
		const env = seams.env ?? process.env;
		ensureDaemonDir(paths.daemonDir);

		const db = new Database(paths.dbPath, {
			strict: true,
			create: true,
			readwrite: true,
		});
		try {
			applyConnectionPragmas(db, DEFAULT_BUSY_TIMEOUT_MS);
			const migrated = readSchemaVersion(db) > 0;
			runMigrations(
				db,
				SCHEMA_STEPS,
				migrated ? { snapshotDir: paths.daemonDir } : {},
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
				mode === "file"
					? undefined
					: (seams.keychain ?? createKeychainBackendForPlatform(paths));

			const resolved = await resolveDataKey({
				existing,
				keyPath: paths.keyPath,
				mode,
				keychain,
			});
			for (const warning of resolved.warnings) {
				console.warn(`dg-daemon: ${warning}`);
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

			const claimLeaseMs = readEnvNumber(
				env,
				"DG_CLAIM_LEASE_MS",
				DEFAULT_CLAIM_LEASE_MS,
			);

			const store = new ChatStore({
				db,
				cipherBox: createCipherBox(resolved.dataKey),
				blindIndexKey: createHmac("sha256", resolved.dataKey)
					.update("dg-overwatch-blind-index")
					.digest(),
				meta: resolved.cryptoMeta,
				claimLeaseMs,
			});
			store.ensureSessionRow(SCHEDULER_SESSION_ID);
			store.ensureSessionRow(OVERWATCH_SESSION_ID);
			return store;
		} catch (err) {
			db.close(false);
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

	#aad(
		domain: string,
		sessionId: string,
		rowId: string,
		formatVersion: number = this.meta.formatVersion,
	): Buffer {
		return buildAad({ domain, sessionId, rowId, formatVersion });
	}

	#withImmediateTransaction<T>(fn: () => T): T {
		this.db.run("BEGIN IMMEDIATE");
		try {
			const result = fn();
			this.db.run("COMMIT");
			return result;
		} catch (err) {
			try {
				this.db.run("ROLLBACK");
			} catch {}
			throw err;
		}
	}

	private decryptMessageBody(row: RawMessageRow, sessionId: string): string {
		const aad = this.#aad(AAD_MESSAGE_BODY, sessionId, row.id);
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
		const aad = this.#aad(AAD_MESSAGE_BODY, input.sessionId, input.id);
		const enc = this.cipherBox.encryptRecord(input.body, aad);
		const createdAt = new Date().toISOString();
		const result = this.#withImmediateTransaction(() => {
			this.ensureSessionRow(input.sessionId);
			const row = this.db
				.query(
					`INSERT INTO messages (id, session_id, role, created_at, body_ciphertext, body_iv, body_tag, attachment_id, subagent_name)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
					input.subagentName ?? null,
				) as { seq: number };
			return { seq: row.seq };
		});
		this.emit(CHAT_STORE_MESSAGE_EVENT, { sessionId: input.sessionId });
		return result;
	}

	insertCommandInvocation(input: InsertCommandInvocationInput): {
		seq: number;
	} {
		const createdAt = new Date().toISOString();

		const argvEnc = this.cipherBox.encryptRecord(
			JSON.stringify(input.argv),
			this.#aad(AAD_COMMAND_ARGV, input.sessionId, input.id),
		);
		const stdoutEnc = this.cipherBox.encryptRecord(
			input.stdout,
			this.#aad(AAD_COMMAND_STDOUT, input.sessionId, input.id),
		);
		const stderrEnc = this.cipherBox.encryptRecord(
			input.stderr,
			this.#aad(AAD_COMMAND_STDERR, input.sessionId, input.id),
		);

		return this.#withImmediateTransaction(() => {
			this.ensureSessionRow(input.sessionId);
			const row = this.db
				.query(
					`INSERT INTO command_invocations (
						id, session_id, created_at,
						argv_ciphertext, argv_iv, argv_tag,
						stdout_ciphertext, stdout_iv, stdout_tag,
						stderr_ciphertext, stderr_iv, stderr_tag,
						truncated, label
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
					input.label ?? null,
				) as { seq: number };
			return { seq: row.seq };
		});
	}

	updateCommandInvocationResult(
		input: UpdateCommandInvocationResultInput,
	): void {
		const stdoutEnc = this.cipherBox.encryptRecord(
			input.stdout,
			this.#aad(AAD_COMMAND_STDOUT, input.sessionId, input.id),
		);
		const stderrEnc = this.cipherBox.encryptRecord(
			input.stderr,
			this.#aad(AAD_COMMAND_STDERR, input.sessionId, input.id),
		);
		this.db.run(
			`UPDATE command_invocations
			 SET stdout_ciphertext = ?, stdout_iv = ?, stdout_tag = ?,
			     stderr_ciphertext = ?, stderr_iv = ?, stderr_tag = ?,
			     truncated = ?
			 WHERE seq = ?`,
			[
				stdoutEnc.ciphertext,
				stdoutEnc.iv,
				stdoutEnc.tag,
				stderrEnc.ciphertext,
				stderrEnc.iv,
				stderrEnc.tag,
				input.truncated ? 1 : 0,
				input.seq,
			],
		);
	}

	saveCommandManifest(input: {
		sessionId: string;
		commands: CommandEntry[];
		subagentNames: string[];
	}): void {
		const commandsEnc = this.cipherBox.encryptRecord(
			JSON.stringify(input.commands),
			this.#aad(AAD_COMMAND_MANIFEST, input.sessionId, input.sessionId),
		);
		const subagentsEnc = this.cipherBox.encryptRecord(
			JSON.stringify(input.subagentNames),
			this.#aad(AAD_SUBAGENT_LIST, input.sessionId, input.sessionId),
		);
		this.#withImmediateTransaction(() => {
			this.ensureSessionRow(input.sessionId);
			this.db.run(
				`INSERT INTO command_manifests (
					session_id, updated_at,
					commands_ciphertext, commands_iv, commands_tag,
					subagents_ciphertext, subagents_iv, subagents_tag
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(session_id) DO UPDATE SET
					updated_at = excluded.updated_at,
					commands_ciphertext = excluded.commands_ciphertext,
					commands_iv = excluded.commands_iv,
					commands_tag = excluded.commands_tag,
					subagents_ciphertext = excluded.subagents_ciphertext,
					subagents_iv = excluded.subagents_iv,
					subagents_tag = excluded.subagents_tag`,
				[
					input.sessionId,
					new Date().toISOString(),
					commandsEnc.ciphertext,
					commandsEnc.iv,
					commandsEnc.tag,
					subagentsEnc.ciphertext,
					subagentsEnc.iv,
					subagentsEnc.tag,
				],
			);
		});
	}

	private readManifestRow(sessionId: string): CommandManifestRow | undefined {
		const row = this.db
			.query(
				`SELECT commands_ciphertext, commands_iv, commands_tag,
				        subagents_ciphertext, subagents_iv, subagents_tag
				 FROM command_manifests WHERE session_id = ?`,
			)
			.get(sessionId) as CommandManifestRow | null;
		return row ?? undefined;
	}

	getCommandManifest(sessionId: string): CommandEntry[] | undefined {
		const row = this.readManifestRow(sessionId);
		if (!row) return undefined;
		const json = this.cipherBox
			.decryptRecord(
				Buffer.from(row.commands_ciphertext),
				Buffer.from(row.commands_iv),
				Buffer.from(row.commands_tag),
				this.#aad(AAD_COMMAND_MANIFEST, sessionId, sessionId),
			)
			.toString("utf8");
		return JSON.parse(json) as CommandEntry[];
	}

	getSubagentNames(sessionId: string): string[] | undefined {
		const row = this.readManifestRow(sessionId);
		if (!row) return undefined;
		const json = this.cipherBox
			.decryptRecord(
				Buffer.from(row.subagents_ciphertext),
				Buffer.from(row.subagents_iv),
				Buffer.from(row.subagents_tag),
				this.#aad(AAD_SUBAGENT_LIST, sessionId, sessionId),
			)
			.toString("utf8");
		return JSON.parse(json) as string[];
	}

	insertStatusEvent(input: InsertStatusEventInput): { seq: number } {
		const createdAt = new Date().toISOString();
		return this.#withImmediateTransaction(() => {
			this.ensureSessionRow(input.sessionId);
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
				this.#aad(AAD_STATUS_PROGRESS, input.sessionId, String(row.seq)),
			);
			this.db.run(
				`UPDATE status_events
				 SET progress_ciphertext = ?, progress_iv = ?, progress_tag = ?
				 WHERE seq = ?`,
				[encrypted.ciphertext, encrypted.iv, encrypted.tag, row.seq],
			);
			return row;
		});
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
					this.#aad(AAD_STATUS_PROGRESS, sessionId, String(row.seq)),
				)
				.toString("utf8") as ProgressState,
			createdAt: row.created_at,
		}));
	}

	recoverStaleClaims(): number {
		return CLAIMABLE_TABLES.reduce(
			(total, table) =>
				total +
				this.db.run(
					`UPDATE ${table} SET claim_id = NULL, claimed_at = NULL WHERE delivered_at IS NULL AND claim_id IS NOT NULL`,
				).changes,
			0,
		);
	}

	claimNext(sessionId: string): ClaimedMessage | undefined {
		const claim = this.#newClaim();
		const row = this.db
			.query(MESSAGE_CLAIM_SQL)
			.get({ ...claim, sessionId }) as RawMessageRow | null;

		if (!row) return undefined;

		const body = this.#decryptOrDrop("messages", row.id, () =>
			this.decryptMessageBody(row, sessionId),
		);
		if (body === undefined) return undefined;

		return {
			claimId: claim.claimId,
			seq: row.seq,
			id: row.id,
			sessionId,
			role: row.role as MessageRole,
			body,
			createdAt: row.created_at,
			attachmentId: row.attachment_id ?? undefined,
			subagentName: row.subagent_name ?? undefined,
		};
	}

	ack(sessionId: string, claimId: string): boolean {
		const row = this.db
			.query(MESSAGE_ACK_SQL)
			.get({ now: Date.now(), sessionId, claimId }) as { seq: number } | null;
		return row !== null;
	}

	insertAgentMessage(input: InsertAgentMessageInput): { seq: number } {
		const enc = this.cipherBox.encryptRecord(
			input.body,
			this.#agentMessageAad(
				input.senderIdentity,
				input.recipientIdentity,
				input.id,
			),
		);
		const result = this.#withImmediateTransaction(() => {
			this.ensureSessionRow(input.senderSessionId);
			const row = this.db
				.query(
					`INSERT INTO agent_messages (id, sender_session_id, sender_identity, recipient_identity, created_at, body_ciphertext, body_iv, body_tag)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
					 RETURNING seq`,
				)
				.get(
					input.id,
					input.senderSessionId,
					input.senderIdentity,
					input.recipientIdentity,
					new Date().toISOString(),
					enc.ciphertext,
					enc.iv,
					enc.tag,
				) as { seq: number };
			return { seq: row.seq };
		});
		this.emit(CHAT_STORE_MESSAGE_EVENT, {
			recipientIdentity: input.recipientIdentity,
		});
		return result;
	}

	/** Deletes agent-to-agent rows past the retention window; returns how many it removed. */
	pruneAgentMessages(now: Date): number {
		const cutoff = new Date(
			now.getTime() - AGENT_MESSAGE_RETENTION_DAYS * MS_PER_DAY,
		).toISOString();
		return this.db.run("DELETE FROM agent_messages WHERE created_at < ?", [
			cutoff,
		]).changes;
	}

	/** Deletes rows past MESSAGE_RETENTION_ROW_LIMIT per session, never an unclaimed one; returns how many it removed. */
	pruneMessages(limit = MESSAGE_RETENTION_ROW_LIMIT): number {
		return this.#withImmediateTransaction(() => {
			const sessionIds = this.db.query("SELECT id FROM sessions").all() as {
				id: string;
			}[];
			let removed = 0;
			for (const { id: sessionId } of sessionIds) {
				const boundary = this.db
					.query(
						`SELECT seq FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?`,
					)
					.get(sessionId, limit - 1) as {
					seq: number;
				} | null;
				if (!boundary) continue;
				removed += this.db.run(
					`DELETE FROM messages
					 WHERE session_id = ? AND seq < ?
					   AND (role = 'agent' OR delivered_at IS NOT NULL)`,
					[sessionId, boundary.seq],
				).changes;
			}
			return removed;
		});
	}

	claimNextAgentMessage(
		identity: string,
		sessionId: string,
	): ClaimedAgentMessage | undefined {
		const claim = this.#newClaim();
		const row = this.db
			.query(AGENT_MESSAGE_CLAIM_SQL)
			.get({ ...claim, identity, sessionId }) as RawAgentMessageRow | null;

		if (!row) return undefined;

		const body = this.#decryptOrDrop("agent_messages", row.id, () =>
			this.cipherBox
				.decryptRecord(
					Buffer.from(row.body_ciphertext),
					Buffer.from(row.body_iv),
					Buffer.from(row.body_tag),
					this.#agentMessageAad(
						row.sender_identity,
						row.recipient_identity,
						row.id,
					),
				)
				.toString("utf8"),
		);
		if (body === undefined) return undefined;

		return {
			claimId: claim.claimId,
			seq: row.seq,
			id: row.id,
			role: "agent",
			from: row.sender_identity,
			to: row.recipient_identity,
			body,
			createdAt: row.created_at,
		};
	}

	ackAgentMessage(identity: string, claimId: string): boolean {
		const row = this.db
			.query(AGENT_MESSAGE_ACK_SQL)
			.get({ now: Date.now(), identity, claimId }) as { seq: number } | null;
		return row !== null;
	}

	#schedulerAad(domain: string, rowId: string): Buffer {
		return this.#aad(domain, SCHEDULER_SESSION_ID, rowId);
	}

	#overwatchAad(domain: string, rowId: string): Buffer {
		return this.#aad(domain, OVERWATCH_SESSION_ID, rowId);
	}

	#overwatchKey(domain: string, value: string): string {
		return createHmac("sha256", this.blindIndexKey)
			.update(domain)
			.update("\0")
			.update(value)
			.digest("hex");
	}

	#encryptOverwatch(domain: string, rowId: string, value: string) {
		return this.cipherBox.encryptRecord(
			value,
			this.#overwatchAad(domain, rowId),
		);
	}

	#decryptOverwatch(
		domain: string,
		rowId: string,
		value: EncryptedOverwatchValue,
	): string {
		return this.cipherBox
			.decryptRecord(
				Buffer.from(value.ciphertext),
				Buffer.from(value.iv),
				Buffer.from(value.tag),
				this.#overwatchAad(domain, rowId),
			)
			.toString("utf8");
	}

	#decryptOptionalOverwatch(
		domain: string,
		rowId: string,
		value: OptionalEncryptedOverwatchValue,
	): string | undefined {
		if (!value.ciphertext || !value.iv || !value.tag) return undefined;
		return this.#decryptOverwatch(domain, rowId, {
			ciphertext: value.ciphertext,
			iv: value.iv,
			tag: value.tag,
		});
	}

	upsertLane(input: UpsertLaneInput): void {
		const existing = this.getBoard().lanes.find(
			(lane) => lane.chat === input.chat,
		);
		const lane = applyOverwatchLaneUpdate(existing, input, input.publisher);
		const rowId = this.#overwatchKey(AAD_OVERWATCH_CHAT, lane.chat);
		const chat = this.#encryptOverwatch(AAD_OVERWATCH_CHAT, rowId, lane.chat);
		const task = this.#encryptOverwatch(AAD_OVERWATCH_TASK, rowId, lane.task);
		const mr = lane.mr
			? this.#encryptOverwatch(AAD_OVERWATCH_MR, rowId, lane.mr)
			: undefined;
		const eta = lane.eta
			? this.#encryptOverwatch(AAD_OVERWATCH_ETA, rowId, lane.eta)
			: undefined;
		const next = lane.next
			? this.#encryptOverwatch(AAD_OVERWATCH_NEXT, rowId, lane.next)
			: undefined;
		const url = lane.url
			? this.#encryptOverwatch(AAD_OVERWATCH_URL, rowId, lane.url)
			: undefined;
		const publisher = this.#encryptOverwatch(
			AAD_OVERWATCH_PUBLISHER,
			rowId,
			lane.publisher,
		);
		this.db.run(
			`INSERT INTO overwatch_lanes (
				chat_key, chat_ciphertext, chat_iv, chat_tag,
				task_ciphertext, task_iv, task_tag, stage,
				mr_ciphertext, mr_iv, mr_tag,
				eta_ciphertext, eta_iv, eta_tag,
				next_ciphertext, next_iv, next_tag,
				url_ciphertext, url_iv, url_tag,
				kind, publisher_ciphertext, publisher_iv, publisher_tag, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(chat_key) DO UPDATE SET
				chat_ciphertext = excluded.chat_ciphertext,
				chat_iv = excluded.chat_iv,
				chat_tag = excluded.chat_tag,
				task_ciphertext = excluded.task_ciphertext,
				task_iv = excluded.task_iv,
				task_tag = excluded.task_tag,
				stage = excluded.stage,
				mr_ciphertext = excluded.mr_ciphertext,
				mr_iv = excluded.mr_iv,
				mr_tag = excluded.mr_tag,
				eta_ciphertext = excluded.eta_ciphertext,
				eta_iv = excluded.eta_iv,
				eta_tag = excluded.eta_tag,
				next_ciphertext = excluded.next_ciphertext,
				next_iv = excluded.next_iv,
				next_tag = excluded.next_tag,
				url_ciphertext = excluded.url_ciphertext,
				url_iv = excluded.url_iv,
				url_tag = excluded.url_tag,
				kind = excluded.kind,
				publisher_ciphertext = excluded.publisher_ciphertext,
				publisher_iv = excluded.publisher_iv,
				publisher_tag = excluded.publisher_tag,
				updated_at = excluded.updated_at`,
			[
				rowId,
				chat.ciphertext,
				chat.iv,
				chat.tag,
				task.ciphertext,
				task.iv,
				task.tag,
				lane.stage,
				mr?.ciphertext ?? null,
				mr?.iv ?? null,
				mr?.tag ?? null,
				eta?.ciphertext ?? null,
				eta?.iv ?? null,
				eta?.tag ?? null,
				next?.ciphertext ?? null,
				next?.iv ?? null,
				next?.tag ?? null,
				url?.ciphertext ?? null,
				url?.iv ?? null,
				url?.tag ?? null,
				lane.kind,
				publisher.ciphertext,
				publisher.iv,
				publisher.tag,
				lane.updatedAt,
			],
		);
	}

	removeLane(chat: string): boolean {
		return (
			this.db.run("DELETE FROM overwatch_lanes WHERE chat_key = ?", [
				this.#overwatchKey(AAD_OVERWATCH_CHAT, chat),
			]).changes > 0
		);
	}

	addMerge(input: AddMergeInput): void {
		const id = this.#overwatchKey(AAD_OVERWATCH_MERGE_MR, input.mr);
		const mr = this.#encryptOverwatch(AAD_OVERWATCH_MERGE_MR, id, input.mr);
		const title = this.#encryptOverwatch(
			AAD_OVERWATCH_MERGE_TITLE,
			id,
			input.title,
		);
		const now = new Date();
		const start = new Date(
			now.getFullYear(),
			now.getMonth(),
			now.getDate(),
		).toISOString();
		this.#withImmediateTransaction(() => {
			this.db.run("DELETE FROM overwatch_merges WHERE at < ?", [start]);
			this.db.run(
				`INSERT INTO overwatch_merges (
					id, mr_ciphertext, mr_iv, mr_tag,
					title_ciphertext, title_iv, title_tag, at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET
					mr_ciphertext = excluded.mr_ciphertext,
					mr_iv = excluded.mr_iv,
					mr_tag = excluded.mr_tag,
					title_ciphertext = excluded.title_ciphertext,
					title_iv = excluded.title_iv,
					title_tag = excluded.title_tag,
					at = excluded.at`,
				[
					id,
					mr.ciphertext,
					mr.iv,
					mr.tag,
					title.ciphertext,
					title.iv,
					title.tag,
					now.toISOString(),
				],
			);
			this.db.run(
				`DELETE FROM overwatch_merges
				 WHERE id NOT IN (
					SELECT id FROM overwatch_merges ORDER BY at DESC LIMIT ?
				 )`,
				[OVERWATCH_MAX_MERGES],
			);
		});
	}

	setLaunch(input: SetLaunchInput): void {
		const rowId = "launch";
		const goLive = this.#encryptOverwatch(
			AAD_OVERWATCH_GO_LIVE,
			rowId,
			input.goLive,
		);
		const goNoGo = input.goNoGo
			? this.#encryptOverwatch(
					AAD_OVERWATCH_GO_NO_GO,
					rowId,
					input.goNoGo,
				)
			: undefined;
		this.db.run(
			`INSERT INTO overwatch_settings (
				id, go_live_ciphertext, go_live_iv, go_live_tag,
				go_no_go_ciphertext, go_no_go_iv, go_no_go_tag
			) VALUES (1, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				go_live_ciphertext = excluded.go_live_ciphertext,
				go_live_iv = excluded.go_live_iv,
				go_live_tag = excluded.go_live_tag,
				go_no_go_ciphertext = excluded.go_no_go_ciphertext,
				go_no_go_iv = excluded.go_no_go_iv,
				go_no_go_tag = excluded.go_no_go_tag`,
			[
				goLive.ciphertext,
				goLive.iv,
				goLive.tag,
				goNoGo?.ciphertext ?? null,
				goNoGo?.iv ?? null,
				goNoGo?.tag ?? null,
			],
		);
	}

	getBoard(): OverwatchBoard {
		const laneRows = this.db
			.query("SELECT * FROM overwatch_lanes ORDER BY updated_at DESC, chat_key")
			.all() as RawOverwatchLaneRow[];
		const lanes = laneRows.map((row): OverwatchLane => ({
			chat: this.#decryptOverwatch(
				AAD_OVERWATCH_CHAT,
				row.chat_key,
				{
					ciphertext: row.chat_ciphertext,
					iv: row.chat_iv,
					tag: row.chat_tag,
				},
			),
			task: this.#decryptOverwatch(
				AAD_OVERWATCH_TASK,
				row.chat_key,
				{
					ciphertext: row.task_ciphertext,
					iv: row.task_iv,
					tag: row.task_tag,
				},
			),
			stage: row.stage,
			mr: this.#decryptOptionalOverwatch(
				AAD_OVERWATCH_MR,
				row.chat_key,
				{
					ciphertext: row.mr_ciphertext,
					iv: row.mr_iv,
					tag: row.mr_tag,
				},
			),
			eta: this.#decryptOptionalOverwatch(
				AAD_OVERWATCH_ETA,
				row.chat_key,
				{
					ciphertext: row.eta_ciphertext,
					iv: row.eta_iv,
					tag: row.eta_tag,
				},
			),
			next: this.#decryptOptionalOverwatch(
				AAD_OVERWATCH_NEXT,
				row.chat_key,
				{
					ciphertext: row.next_ciphertext,
					iv: row.next_iv,
					tag: row.next_tag,
				},
			),
			url: this.#decryptOptionalOverwatch(
				AAD_OVERWATCH_URL,
				row.chat_key,
				{
					ciphertext: row.url_ciphertext,
					iv: row.url_iv,
					tag: row.url_tag,
				},
			),
			kind: row.kind,
			publisher: this.#decryptOverwatch(
				AAD_OVERWATCH_PUBLISHER,
				row.chat_key,
				{
					ciphertext: row.publisher_ciphertext,
					iv: row.publisher_iv,
					tag: row.publisher_tag,
				},
			),
			updatedAt: row.updated_at,
		}));

		const now = new Date();
		const start = new Date(
			now.getFullYear(),
			now.getMonth(),
			now.getDate(),
		).toISOString();
		const end = new Date(
			now.getFullYear(),
			now.getMonth(),
			now.getDate() + 1,
		).toISOString();
		const mergeRows = this.db
			.query(
				"SELECT * FROM overwatch_merges WHERE at >= ? AND at < ? ORDER BY at DESC",
			)
			.all(start, end) as RawOverwatchMergeRow[];
		const merges = mergeRows.map((row): OverwatchMerge => ({
			mr: this.#decryptOverwatch(
				AAD_OVERWATCH_MERGE_MR,
				row.id,
				{
					ciphertext: row.mr_ciphertext,
					iv: row.mr_iv,
					tag: row.mr_tag,
				},
			),
			title: this.#decryptOverwatch(
				AAD_OVERWATCH_MERGE_TITLE,
				row.id,
				{
					ciphertext: row.title_ciphertext,
					iv: row.title_iv,
					tag: row.title_tag,
				},
			),
			at: row.at,
		}));

		const settings = this.db
			.query("SELECT * FROM overwatch_settings WHERE id = 1")
			.get() as RawOverwatchSettingsRow | null;
		const goLive = settings
			? this.#decryptOptionalOverwatch(
					AAD_OVERWATCH_GO_LIVE,
					"launch",
					{
						ciphertext: settings.go_live_ciphertext,
						iv: settings.go_live_iv,
						tag: settings.go_live_tag,
					},
				)
			: undefined;
		const goNoGo = settings
			? this.#decryptOptionalOverwatch(
					AAD_OVERWATCH_GO_NO_GO,
					"launch",
					{
						ciphertext: settings.go_no_go_ciphertext,
						iv: settings.go_no_go_iv,
						tag: settings.go_no_go_tag,
					},
				)
			: undefined;

		return {
			...(goLive ? { goLive } : {}),
			...(goNoGo ? { goNoGo } : {}),
			lanes,
			merges,
		};
	}

	#decryptOptional(
		domain: string,
		rowId: string,
		ciphertext: Uint8Array | null,
		iv: Uint8Array | null,
		tag: Uint8Array | null,
	): string | undefined {
		if (!ciphertext || !iv || !tag) return undefined;
		return this.cipherBox
			.decryptRecord(
				Buffer.from(ciphertext),
				Buffer.from(iv),
				Buffer.from(tag),
				this.#schedulerAad(domain, rowId),
			)
			.toString("utf8");
	}

	#hydrateJob(row: RawJobRow): ScheduledJob {
		const argv = this.cipherBox
			.decryptRecord(
				Buffer.from(row.argv_ciphertext),
				Buffer.from(row.argv_iv),
				Buffer.from(row.argv_tag),
				this.#schedulerAad(AAD_JOB_ARGV, row.id),
			)
			.toString("utf8");
		return {
			id: row.id,
			label: row.label,
			argv: JSON.parse(argv) as string[],
			cwd: row.cwd,
			intervalMs: row.interval_ms ?? undefined,
			cronExpr: row.cron_expr ?? undefined,
			enabled: row.enabled === 1,
			createdAt: row.created_at,
			nextRunAt: row.next_run_at,
			notifyIdentity: row.notify_identity ?? undefined,
			lastRunAt: row.last_run_at ?? undefined,
			lastExitCode: row.last_exit_code ?? undefined,
			lastError: this.#decryptOptional(
				AAD_JOB_ERROR,
				row.id,
				row.last_error_ciphertext,
				row.last_error_iv,
				row.last_error_tag,
			),
			lastStderr: this.#decryptOptional(
				AAD_JOB_STDERR,
				row.id,
				row.last_stderr_ciphertext,
				row.last_stderr_iv,
				row.last_stderr_tag,
			),
		};
	}

	#hydrateJobSummary(row: RawJobSummaryRow): JobSummary {
		return {
			id: row.id,
			label: row.label,
			intervalMs: row.interval_ms ?? undefined,
			cronExpr: row.cron_expr ?? undefined,
			enabled: row.enabled === 1,
			nextRunAt: row.next_run_at,
			notifyIdentity: row.notify_identity ?? undefined,
			lastRunAt: row.last_run_at ?? undefined,
			lastExitCode: row.last_exit_code ?? undefined,
			lastError: this.#decryptOptional(
				AAD_JOB_ERROR,
				row.id,
				row.last_error_ciphertext,
				row.last_error_iv,
				row.last_error_tag,
			),
		};
	}

	#hydrateFeedItem(row: RawFeedItemRow): FeedItem {
		return {
			id: row.id,
			jobId: row.job_id,
			fingerprint: row.fingerprint,
			createdAt: row.created_at,
			title: this.cipherBox
				.decryptRecord(
					Buffer.from(row.title_ciphertext),
					Buffer.from(row.title_iv),
					Buffer.from(row.title_tag),
					this.#schedulerAad(AAD_FEED_TITLE, row.id),
				)
				.toString("utf8"),
			meta: this.#decryptOptional(
				AAD_FEED_META,
				row.id,
				row.meta_ciphertext,
				row.meta_iv,
				row.meta_tag,
			),
			url: this.#decryptOptional(
				AAD_FEED_URL,
				row.id,
				row.url_ciphertext,
				row.url_iv,
				row.url_tag,
			),
			readAt: row.read_at ?? undefined,
		};
	}

	insertJob(input: InsertJobInput): ScheduledJob {
		const id = randomUUID();
		const now = new Date().toISOString();
		const argv = this.cipherBox.encryptRecord(
			JSON.stringify(input.argv),
			this.#schedulerAad(AAD_JOB_ARGV, id),
		);
		this.db.run(
			`INSERT INTO scheduled_jobs (
				id, label, created_at,
				argv_ciphertext, argv_iv, argv_tag,
				cwd, interval_ms, cron_expr, enabled, notify_identity, next_run_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				input.label,
				now,
				argv.ciphertext,
				argv.iv,
				argv.tag,
				input.cwd,
				input.intervalMs ?? null,
				input.cronExpr ?? null,
				input.enabled === false ? 0 : 1,
				input.notifyIdentity ?? null,
				input.nextRunAt ?? now,
			],
		);
		const job = this.getJob(id);
		if (!job) throw new Error(`insertJob: job ${id} vanished after insert`);
		return job;
	}

	getJob(id: string): ScheduledJob | undefined {
		const row = this.db
			.query("SELECT * FROM scheduled_jobs WHERE id = ?")
			.get(id) as RawJobRow | null;
		return row ? this.#hydrateJob(row) : undefined;
	}

	getJobByLabel(label: string): ScheduledJob | undefined {
		const row = this.db
			.query("SELECT * FROM scheduled_jobs WHERE label = ?")
			.get(label) as RawJobRow | null;
		return row ? this.#hydrateJob(row) : undefined;
	}

	listJobs(): ScheduledJob[] {
		const rows = this.db
			.query("SELECT * FROM scheduled_jobs ORDER BY created_at ASC, label ASC")
			.all() as RawJobRow[];
		return rows.map((row) => this.#hydrateJob(row));
	}

	/** For `GET /jobs`: every job's dashboard-facing fields, decrypting only `last_error`. */
	listJobSummaries(): JobSummary[] {
		const rows = this.db
			.query(
				`SELECT ${JOB_SUMMARY_SELECTION} FROM scheduled_jobs ORDER BY created_at ASC, label ASC`,
			)
			.all() as RawJobSummaryRow[];
		return rows.map((row) => this.#hydrateJobSummary(row));
	}

	dueJobs(now: Date): ScheduledJob[] {
		const rows = this.db
			.query(
				`SELECT * FROM scheduled_jobs
				 WHERE enabled = 1 AND next_run_at <= ?
				 ORDER BY next_run_at ASC`,
			)
			.all(now.toISOString()) as RawJobRow[];
		return rows.map((row) => this.#hydrateJob(row));
	}

	countEnabledJobs(): number {
		const row = this.db
			.query("SELECT COUNT(*) AS count FROM scheduled_jobs WHERE enabled = 1")
			.get() as { count: number };
		return row.count;
	}

	setJobEnabled(id: string, enabled: boolean): boolean {
		const row = this.db
			.query("UPDATE scheduled_jobs SET enabled = ? WHERE id = ? RETURNING id")
			.get(enabled ? 1 : 0, id) as { id: string } | null;
		return row !== null;
	}

	deleteJob(id: string): boolean {
		const row = this.db
			.query("DELETE FROM scheduled_jobs WHERE id = ? RETURNING id")
			.get(id) as { id: string } | null;
		return row !== null;
	}

	recordJobRun(input: RecordJobRunInput): void {
		const job = this.getJob(input.jobId);
		if (!job) throw new Error(`recordJobRun: unknown job ${input.jobId}`);

		const ranAt = input.ranAt.toISOString();
		const nextRunAt = computeNextRunAt(job, input.ranAt).toISOString();
		const error = input.error
			? this.cipherBox.encryptRecord(
					input.error,
					this.#schedulerAad(AAD_JOB_ERROR, input.jobId),
				)
			: undefined;
		const stderr = input.stderr
			? this.cipherBox.encryptRecord(
					input.stderr,
					this.#schedulerAad(AAD_JOB_STDERR, input.jobId),
				)
			: undefined;

		this.db.run(
			`UPDATE scheduled_jobs
			 SET last_run_at = ?, next_run_at = ?, last_exit_code = ?,
			     last_error_ciphertext = ?, last_error_iv = ?, last_error_tag = ?,
			     last_stderr_ciphertext = ?, last_stderr_iv = ?, last_stderr_tag = ?
			 WHERE id = ?`,
			[
				ranAt,
				nextRunAt,
				input.exitCode,
				error?.ciphertext ?? null,
				error?.iv ?? null,
				error?.tag ?? null,
				stderr?.ciphertext ?? null,
				stderr?.iv ?? null,
				stderr?.tag ?? null,
				input.jobId,
			],
		);
	}

	insertFeedItems(
		jobId: string,
		items: FeedItemInput[],
	): InsertFeedItemsResult {
		const inserted: FeedItemInput[] = [];
		for (let start = 0; start < items.length; start += FEED_INSERT_CHUNK) {
			this.#insertFeedChunk(
				jobId,
				items.slice(start, start + FEED_INSERT_CHUNK),
				inserted,
			);
		}
		return { inserted, duplicates: items.length - inserted.length };
	}

	#insertFeedChunk(
		jobId: string,
		items: FeedItemInput[],
		inserted: FeedItemInput[],
	): void {
		this.#withImmediateTransaction(() => {
			for (const item of items) {
				const id = randomUUID();
				const title = this.cipherBox.encryptRecord(
					item.title,
					this.#schedulerAad(AAD_FEED_TITLE, id),
				);
				const meta = item.meta
					? this.cipherBox.encryptRecord(
							item.meta,
							this.#schedulerAad(AAD_FEED_META, id),
						)
					: undefined;
				const url = item.url
					? this.cipherBox.encryptRecord(
							item.url,
							this.#schedulerAad(AAD_FEED_URL, id),
						)
					: undefined;

				const rows = this.db
					.query(
						`INSERT INTO feed_items (
							id, job_id, fingerprint, created_at,
							title_ciphertext, title_iv, title_tag,
							meta_ciphertext, meta_iv, meta_tag,
							url_ciphertext, url_iv, url_tag
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
						ON CONFLICT(job_id, fingerprint) DO NOTHING
						RETURNING id`,
					)
					.all(
						id,
						jobId,
						item.fingerprint,
						new Date().toISOString(),
						title.ciphertext,
						title.iv,
						title.tag,
						meta?.ciphertext ?? null,
						meta?.iv ?? null,
						meta?.tag ?? null,
						url?.ciphertext ?? null,
						url?.iv ?? null,
						url?.tag ?? null,
					) as { id: string }[];
				if (rows.length > 0) inserted.push(item);
			}
		});
	}

	listFeedItems(options: ListFeedItemsOptions = {}): FeedItem[] {
		const filters: string[] = [];
		const params: (string | number)[] = [];
		if (options.jobId) {
			filters.push("job_id = ?");
			params.push(options.jobId);
		}
		if (options.unreadOnly) filters.push("read_at IS NULL");
		const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
		params.push(options.limit ?? DEFAULT_FEED_PAGE_LIMIT);

		const rows = this.db
			.query(`SELECT * FROM feed_items ${where} ORDER BY seq DESC LIMIT ?`)
			.all(...params) as RawFeedItemRow[];
		return rows.map((row) => this.#hydrateFeedItem(row));
	}

	getFeedItem(id: string): FeedItem | undefined {
		const row = this.db
			.query("SELECT * FROM feed_items WHERE id = ?")
			.get(id) as RawFeedItemRow | null;
		return row ? this.#hydrateFeedItem(row) : undefined;
	}

	markFeedItemRead(id: string): boolean {
		this.db.run(
			`UPDATE feed_items SET read_at = ?
			 WHERE id = ? AND read_at IS NULL`,
			[new Date().toISOString(), id],
		);
		return this.getFeedItem(id) !== undefined;
	}

	markAllRead(jobId?: string): number {
		const now = new Date().toISOString();
		const rows = jobId
			? (this.db
					.query(
						`UPDATE feed_items SET read_at = ?
						 WHERE job_id = ? AND read_at IS NULL
						 RETURNING id`,
					)
					.all(now, jobId) as { id: string }[])
			: (this.db
					.query(
						`UPDATE feed_items SET read_at = ?
						 WHERE read_at IS NULL
						 RETURNING id`,
					)
					.all(now) as { id: string }[]);
		return rows.length;
	}

	countUnreadByJob(): Record<string, number> {
		const rows = this.db
			.query(
				`SELECT job_id, COUNT(*) AS count FROM feed_items
				 WHERE read_at IS NULL
				 GROUP BY job_id`,
			)
			.all() as { job_id: string; count: number }[];
		const counts: Record<string, number> = {};
		for (const row of rows) counts[row.job_id] = row.count;
		return counts;
	}

	/** Deletes rows past FEED_ITEM_RETENTION_ROW_LIMIT per job, keeping the newest ones. Returns how many rows it removed. */
	pruneFeedItems(limit = FEED_ITEM_RETENTION_ROW_LIMIT): number {
		return this.#withImmediateTransaction(() => {
			const jobIds = this.db.query("SELECT id FROM scheduled_jobs").all() as {
				id: string;
			}[];
			let removed = 0;
			for (const { id: jobId } of jobIds) {
				const boundary = this.db
					.query(
						`SELECT seq FROM feed_items WHERE job_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?`,
					)
					.get(jobId, limit - 1) as {
					seq: number;
				} | null;
				if (!boundary) continue;
				removed += this.db.run(
					`DELETE FROM feed_items WHERE job_id = ? AND seq < ?`,
					[jobId, boundary.seq],
				).changes;
			}
			return removed;
		});
	}

	#newClaim(): { claimId: string; now: number; leaseCutoff: number } {
		const now = Date.now();
		return {
			claimId: randomUUID(),
			now,
			leaseCutoff: now - this.claimLeaseMs,
		};
	}

	#agentMessageAad(from: string, to: string, rowId: string): Buffer {
		return this.#aad(AAD_AGENT_MESSAGE_BODY, JSON.stringify([from, to]), rowId);
	}

	#decryptOrDrop<T>(
		table: string,
		rowId: string,
		decrypt: () => T,
	): T | undefined {
		try {
			return decrypt();
		} catch (err) {
			this.db.run(`UPDATE ${table} SET delivered_at = ? WHERE id = ?`, [
				Date.now(),
				rowId,
			]);
			console.warn(
				`dg-daemon: dropped ${table} row ${rowId} from the queue — its body did not decrypt: ${describeError(err)}`,
			);
			return undefined;
		}
	}

	#toPeekedMessage(row: RawMessageRow, sessionId: string): PeekedMessage {
		return {
			seq: row.seq,
			id: row.id,
			role: row.role as MessageRole,
			body: this.decryptMessageBody(row, sessionId),
			createdAt: row.created_at,
			attachmentId: row.attachment_id ?? undefined,
			subagentName: row.subagent_name ?? undefined,
		};
	}

	peekAll(sessionId: string): PeekedMessage[] {
		const rows = this.db
			.query(
				`SELECT seq, id, role, created_at, body_ciphertext, body_iv, body_tag, attachment_id, subagent_name
				 FROM messages WHERE session_id = ? ORDER BY seq ASC`,
			)
			.all(sessionId) as RawMessageRow[];
		return rows.map((row) => this.#toPeekedMessage(row, sessionId));
	}

	peekTail(sessionId: string, limit: number): PeekedMessage[] {
		const rows = this.db
			.query(
				`SELECT seq, id, role, created_at, body_ciphertext, body_iv, body_tag, attachment_id, subagent_name
				 FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?`,
			)
			.all(sessionId, limit) as RawMessageRow[];
		return rows.reverse().map((row) => this.#toPeekedMessage(row, sessionId));
	}

	/** Equivalent to `fitHistoryPage(peekTail(sessionId, maxRows), overheadBytes)`, without decrypting rows past the fitted budget. */
	peekTailForHistory(
		sessionId: string,
		overheadBytes: number,
		maxRows: number,
	): PeekedMessage[] {
		const newestFirst: PeekedMessage[] = [];
		let used = overheadBytes;
		let cursorSeq: number | undefined;
		let scanned = 0;
		while (scanned < maxRows) {
			const batchLimit = Math.min(HISTORY_TAIL_BATCH_ROWS, maxRows - scanned);
			const rows = (
				cursorSeq === undefined
					? this.db
							.query(
								`SELECT ${MESSAGE_SELECTION} FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?`,
							)
							.all(sessionId, batchLimit)
					: this.db
							.query(
								`SELECT ${MESSAGE_SELECTION} FROM messages WHERE session_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?`,
							)
							.all(sessionId, cursorSeq, batchLimit)
			) as RawMessageRow[];
			if (rows.length === 0) break;
			for (const row of rows) {
				scanned++;
				const message = this.#toPeekedMessage(row, sessionId);
				if (used + historyItemCost(message) > CHAT_MAX_PAYLOAD_BYTES) {
					return newestFirst.reverse();
				}
				used += historyItemCost(message);
				newestFirst.push(message);
			}
			cursorSeq = rows[rows.length - 1].seq;
			if (rows.length < batchLimit) break;
		}
		return newestFirst.reverse();
	}

	insertAsset(input: InsertAssetInput): void {
		if (input.byteLength > CHAT_MAX_ASSET_BYTES) {
			throw new AssetTooLargeError(input.byteLength);
		}
		const enc = this.cipherBox.encryptRecord(
			input.filename,
			this.#aad(AAD_ASSET_FILENAME, input.sessionId, input.id),
		);
		this.#withImmediateTransaction(() => {
			this.ensureSessionRow(input.sessionId);
			this.db.run(
				`INSERT INTO assets (id, session_id, created_at, filename_ciphertext, filename_iv, filename_tag, content_type, byte_length, deleted_at, state)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'active')`,
				[
					input.id,
					input.sessionId,
					new Date().toISOString(),
					enc.ciphertext,
					enc.iv,
					enc.tag,
					input.contentType,
					input.byteLength,
				],
			);
		});
	}

	getAsset(sessionId: string, id: string): AssetRow | undefined {
		const row = this.db
			.query(
				`SELECT id, session_id, filename_ciphertext, filename_iv, filename_tag, content_type, byte_length, state
				 FROM assets WHERE id = ? AND session_id = ?`,
			)
			.get(id, sessionId) as RawAssetRow | null;
		if (!row) return undefined;

		const filename = this.cipherBox
			.decryptRecord(
				Buffer.from(row.filename_ciphertext),
				Buffer.from(row.filename_iv),
				Buffer.from(row.filename_tag),
				this.#aad(AAD_ASSET_FILENAME, sessionId, id),
			)
			.toString("utf8");

		return {
			id: row.id,
			sessionId: row.session_id,
			filename,
			contentType: row.content_type,
			byteLength: row.byte_length,
			state: row.state as AssetState,
		};
	}

	pruneSessionAssets(sessionId: string): void {
		this.db.run(
			`UPDATE assets SET state = 'deleted', deleted_at = ? WHERE session_id = ? AND state = 'active'`,
			[new Date().toISOString(), sessionId],
		);
	}

	#assetBytesAad(sessionId: string, id: string): Buffer {
		return this.#aad(
			AAD_ASSET_BYTES,
			sessionId,
			id,
			AAD_ASSET_BYTES_FORMAT_VERSION,
		);
	}

	encryptAssetBytes(
		sessionId: string,
		id: string,
		plaintext: Buffer,
	): CipherEnvelope {
		return this.cipherBox.encryptBytes(
			plaintext,
			this.#assetBytesAad(sessionId, id),
		);
	}

	decryptAssetBytes(
		sessionId: string,
		id: string,
		envelope: CipherEnvelope,
	): Buffer {
		return this.cipherBox.decryptRecord(
			envelope.ciphertext,
			envelope.iv,
			envelope.tag,
			this.#assetBytesAad(sessionId, id),
		);
	}
}
