import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import {
	type CredentialGrantSummary,
	type CredentialRecord,
	type CredentialSummary,
	validateCredentialGrantPrefix,
	validateCredentialMeta,
	validateCredentialName,
	validateCredentialValue,
} from "@dg/common";
import {
	applyConnectionPragmas,
	DEFAULT_BUSY_TIMEOUT_MS,
	type DgPaths,
	ensurePrivateDir,
	type MigrationStep,
	mintToken,
	runMigrations,
	tokensEqual,
} from "@dg/common/node";
import { buildAad, type CipherBox, createCipherBox } from "../crypto/envelope";
import {
	type CryptoMetaRow,
	resolveKeyMode,
	resolveSiblingDataKey,
} from "../crypto/key-resolution";
import { createKeychainBackendForPlatform } from "../crypto/keychain-backends";
import type { StoreSeams } from ".";

const AAD_CREDENTIAL_VALUE = "credentials.value";
const CREDENTIALS_AAD_SCOPE = "credentials";
const UNKNOWN_GRANT_HASH = "0".repeat(64);

function createV1Credentials(db: Database): void {
	db.run(`CREATE TABLE crypto_meta (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		format_version INTEGER NOT NULL,
		key_id TEXT NOT NULL,
		key_source TEXT NOT NULL,
		wrapped_data_key BLOB NOT NULL
	) STRICT`);
	db.run(`CREATE TABLE credentials (
		name TEXT PRIMARY KEY CHECK(length(name) BETWEEN 1 AND 128),
		value_ciphertext BLOB NOT NULL,
		value_iv BLOB NOT NULL CHECK(length(value_iv) = 12),
		value_tag BLOB NOT NULL CHECK(length(value_tag) = 16),
		meta_json TEXT NOT NULL,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	) STRICT`);
	db.run(`CREATE TABLE credential_grants (
		prefix TEXT PRIMARY KEY CHECK(length(prefix) BETWEEN 1 AND 64),
		token_hash TEXT NOT NULL CHECK(length(token_hash) = 64),
		created_at TEXT NOT NULL,
		last_used_at TEXT
	) STRICT`);
}

export const CREDENTIALS_SCHEMA_STEPS: MigrationStep[] = [
	{ version: 1, run: createV1Credentials },
];

function hashToken(token: string): string {
	return createHash("sha256").update(token, "utf8").digest("hex");
}

type RawCryptoMeta = {
	format_version: number;
	key_id: string;
	key_source: string;
	wrapped_data_key: Uint8Array;
};

/** Secrets in their own `credentials.db`, under a data key separate from `daemon.db`'s. */
export class CredentialStore {
	private constructor(
		private readonly db: Database,
		private readonly cipherBox: CipherBox,
		private readonly formatVersion: number,
	) {}

	/** Opens or creates the 0600 file and wraps its own data key with the KEK `daemon.db` recorded. */
	static async open(
		paths: DgPaths,
		kek: Pick<CryptoMetaRow, "keyId" | "keySource">,
		seams: StoreSeams = {},
	): Promise<CredentialStore> {
		const env = seams.env ?? process.env;
		ensurePrivateDir(paths.daemonDir);
		if (!existsSync(paths.credentialsDbPath))
			writeFileSync(paths.credentialsDbPath, "", { mode: 0o600 });
		chmodSync(paths.credentialsDbPath, 0o600);
		const db = new Database(paths.credentialsDbPath, {
			strict: true,
			readwrite: true,
		});
		try {
			applyConnectionPragmas(db, DEFAULT_BUSY_TIMEOUT_MS);
			runMigrations(db, CREDENTIALS_SCHEMA_STEPS);
			const row = db
				.query(
					"SELECT format_version, key_id, key_source, wrapped_data_key FROM crypto_meta WHERE id = 1",
				)
				.get() as RawCryptoMeta | null;
			const mode = resolveKeyMode(env.DG_KEY_SOURCE);
			const resolved = await resolveSiblingDataKey({
				existing: row
					? {
							formatVersion: row.format_version,
							keyId: row.key_id,
							keySource: row.key_source,
							wrappedDataKey: Buffer.from(row.wrapped_data_key),
						}
					: undefined,
				kek,
				keyPath: paths.keyPath,
				mode,
				keychain:
					mode === "file"
						? undefined
						: (seams.keychain ?? createKeychainBackendForPlatform(paths)),
			});
			if (!row)
				db.run(
					"INSERT INTO crypto_meta (id, format_version, key_id, key_source, wrapped_data_key) VALUES (1, ?, ?, ?, ?)",
					[
						resolved.cryptoMeta.formatVersion,
						resolved.cryptoMeta.keyId,
						resolved.cryptoMeta.keySource,
						resolved.cryptoMeta.wrappedDataKey,
					],
				);
			return new CredentialStore(
				db,
				createCipherBox(resolved.dataKey),
				resolved.cryptoMeta.formatVersion,
			);
		} catch (err) {
			db.close();
			throw err;
		}
	}

	close(): void {
		this.db.close(true);
	}

	#aad(name: string): Buffer {
		return buildAad({
			domain: AAD_CREDENTIAL_VALUE,
			sessionId: CREDENTIALS_AAD_SCOPE,
			rowId: name,
			formatVersion: this.formatVersion,
		});
	}

	/** Encrypts the secret under AAD bound to the table, column and name; meta stays plaintext. */
	setCredential(name: string, value: string, meta: unknown = {}): void {
		validateCredentialName(name);
		const secret = validateCredentialValue(value);
		const validatedMeta = validateCredentialMeta(meta);
		const enc = this.cipherBox.encryptRecord(secret, this.#aad(name));
		const now = new Date().toISOString();
		this.db.run(
			"INSERT INTO credentials (name, value_ciphertext, value_iv, value_tag, meta_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET value_ciphertext = excluded.value_ciphertext, value_iv = excluded.value_iv, value_tag = excluded.value_tag, meta_json = excluded.meta_json, updated_at = excluded.updated_at",
			[
				name,
				enc.ciphertext,
				enc.iv,
				enc.tag,
				JSON.stringify(validatedMeta),
				now,
				now,
			],
		);
	}

	/** Decrypts a named credential, returning undefined when it is absent. */
	getCredential(name: string): CredentialRecord | undefined {
		validateCredentialName(name);
		const row = this.db
			.query(
				"SELECT value_ciphertext, value_iv, value_tag, meta_json, updated_at FROM credentials WHERE name = ?",
			)
			.get(name) as {
			value_ciphertext: Uint8Array;
			value_iv: Uint8Array;
			value_tag: Uint8Array;
			meta_json: string;
			updated_at: string;
		} | null;
		if (!row) return undefined;
		const value = this.cipherBox
			.decryptRecord(
				Buffer.from(row.value_ciphertext),
				Buffer.from(row.value_iv),
				Buffer.from(row.value_tag),
				this.#aad(name),
			)
			.toString("utf8");
		return {
			value,
			meta: JSON.parse(row.meta_json),
			updatedAt: row.updated_at,
		};
	}

	/** Lists sorted names and metadata without reading the encrypted columns. */
	listCredentials(): CredentialSummary[] {
		return (
			this.db
				.query(
					"SELECT name, meta_json, updated_at FROM credentials ORDER BY name",
				)
				.all() as { name: string; meta_json: string; updated_at: string }[]
		).map((row) => ({
			name: row.name,
			meta: JSON.parse(row.meta_json),
			updatedAt: row.updated_at,
		}));
	}

	/** Removes a named credential and reports whether one existed. */
	deleteCredential(name: string): boolean {
		validateCredentialName(name);
		return (
			this.db.run("DELETE FROM credentials WHERE name = ?", [name]).changes > 0
		);
	}

	/** Mints a service token for the prefix, keeping only its SHA-256; a repeat rotates it. */
	createCredentialGrant(prefix: string): string {
		validateCredentialGrantPrefix(prefix);
		const token = mintToken();
		this.db.run(
			"INSERT INTO credential_grants (prefix, token_hash, created_at, last_used_at) VALUES (?, ?, ?, NULL) ON CONFLICT(prefix) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at, last_used_at = NULL",
			[prefix, hashToken(token), new Date().toISOString()],
		);
		return token;
	}

	/** Compares token hashes in constant time and records the use on success. */
	verifyCredentialGrant(prefix: string, token: string): boolean {
		const row = this.db
			.query("SELECT token_hash FROM credential_grants WHERE prefix = ?")
			.get(prefix) as { token_hash: string } | null;
		const matches = tokensEqual(
			row?.token_hash ?? UNKNOWN_GRANT_HASH,
			hashToken(token),
		);
		if (!row || !matches) return false;
		this.db.run(
			"UPDATE credential_grants SET last_used_at = ? WHERE prefix = ?",
			[new Date().toISOString(), prefix],
		);
		return true;
	}

	/** Lists grants without their token hashes. */
	listCredentialGrants(): CredentialGrantSummary[] {
		return (
			this.db
				.query(
					"SELECT prefix, created_at, last_used_at FROM credential_grants ORDER BY prefix",
				)
				.all() as {
				prefix: string;
				created_at: string;
				last_used_at: string | null;
			}[]
		).map((row) => ({
			prefix: row.prefix,
			createdAt: row.created_at,
			lastUsedAt: row.last_used_at,
		}));
	}

	/** Removes a grant and reports whether one existed. */
	deleteCredentialGrant(prefix: string): boolean {
		validateCredentialGrantPrefix(prefix);
		return (
			this.db.run("DELETE FROM credential_grants WHERE prefix = ?", [prefix])
				.changes > 0
		);
	}
}
