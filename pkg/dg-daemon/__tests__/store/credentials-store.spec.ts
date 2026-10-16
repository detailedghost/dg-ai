import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type DgPaths, resolveDgPaths } from "@dg/common/node";
import { buildAad, createCipherBox } from "../../src/crypto/envelope";
import { resolveDataKey } from "../../src/crypto/key-resolution";
import { ChatStore } from "../../src/store";
import { CredentialStore } from "../../src/store/credentials-store";
import { CURRENT_SCHEMA_VERSION } from "../../src/store/schema";
import {
	cleanupDgHome,
	FILE_ONLY_SEAMS,
	freshDgHome,
	scanFileForBytes,
} from "../utils/daemon-harness";

async function withStores(
	run: (stores: {
		paths: DgPaths;
		chat: ChatStore;
		credentials: CredentialStore;
	}) => Promise<void> | void,
) {
	const dgHome = freshDgHome();
	const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
	const chat = await ChatStore.open(paths, FILE_ONLY_SEAMS);
	const credentials = await CredentialStore.open(
		paths,
		chat.cryptoMeta(),
		FILE_ONLY_SEAMS,
	);
	try {
		await run({ paths, chat, credentials });
	} finally {
		credentials.close();
		chat.close();
		cleanupDgHome(dgHome);
	}
}

const meta = {
	provider: "example",
	site: "eu",
	scopes: ["read"],
	expiresAt: "2030-01-01T00:00:00.000Z",
	note: "fixture",
};

describe("CredentialStore file and key", () => {
	it("creates credentials.db with mode 0600 beside daemon.db and leaves daemon.db's schema alone", async () => {
		await withStores(({ paths, chat }) => {
			expect(paths.credentialsDbPath).toBe(
				join(paths.daemonDir, "credentials.db"),
			);
			expect(statSync(paths.credentialsDbPath).mode & 0o777).toBe(0o600);
			expect(statSync(paths.daemonDir).mode & 0o777).toBe(0o700);
			expect(chat.userVersion()).toBe(CURRENT_SCHEMA_VERSION);
			const daemonDb = new Database(paths.dbPath, { readonly: true });
			try {
				expect(
					daemonDb
						.query(
							"SELECT name FROM sqlite_master WHERE name IN ('credentials', 'credential_grants')",
						)
						.all(),
				).toEqual([]);
			} finally {
				daemonDb.close();
			}
		});
	});

	it("wraps its own data key, so daemon.db's data key cannot decrypt a credential", async () => {
		await withStores(async ({ paths, chat, credentials }) => {
			credentials.setCredential("consumer/example", "fixture-own-key-value");
			const raw = new Database(paths.credentialsDbPath, { readonly: true });
			const row = raw
				.query("SELECT value_ciphertext, value_iv, value_tag FROM credentials")
				.get() as {
				value_ciphertext: Uint8Array;
				value_iv: Uint8Array;
				value_tag: Uint8Array;
			};
			const ownMeta = raw
				.query("SELECT key_id, wrapped_data_key FROM crypto_meta")
				.get() as { key_id: string; wrapped_data_key: Uint8Array };
			raw.close();
			const chatMeta = chat.cryptoMeta();
			expect(ownMeta.key_id).toBe(chatMeta.keyId);
			const { dataKey } = await resolveDataKey({
				existing: {
					formatVersion: chatMeta.formatVersion,
					keyId: chatMeta.keyId,
					keySource: chatMeta.keySource,
					wrappedDataKey: Buffer.from(chatMeta.wrappedDataKey),
				},
				keyPath: paths.keyPath,
				mode: "file",
			});
			expect(Buffer.from(ownMeta.wrapped_data_key)).not.toEqual(
				Buffer.from(chatMeta.wrappedDataKey),
			);
			expect(() =>
				createCipherBox(dataKey).decryptRecord(
					Buffer.from(row.value_ciphertext),
					Buffer.from(row.value_iv),
					Buffer.from(row.value_tag),
					buildAad({
						domain: "credentials.value",
						sessionId: "credentials",
						rowId: "consumer/example",
						formatVersion: chatMeta.formatVersion,
					}),
				),
			).toThrow();
		});
	});

	it("reopens with the same data key", async () => {
		const dgHome = freshDgHome();
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		try {
			const chat = await ChatStore.open(paths, FILE_ONLY_SEAMS);
			let store = await CredentialStore.open(
				paths,
				chat.cryptoMeta(),
				FILE_ONLY_SEAMS,
			);
			store.setCredential("consumer/example", "fixture-reopen-value", meta);
			store.close();
			store = await CredentialStore.open(
				paths,
				chat.cryptoMeta(),
				FILE_ONLY_SEAMS,
			);
			expect(store.getCredential("consumer/example")).toMatchObject({
				value: "fixture-reopen-value",
				meta,
			});
			store.close();
			chat.close();
		} finally {
			cleanupDgHome(dgHome);
		}
	});
});

describe("CredentialStore credentials", () => {
	it("round-trips, replaces and keeps the value out of the file bytes", async () => {
		await withStores(({ paths, credentials }) => {
			const value = "fixture-credential-plaintext-91c2be";
			credentials.setCredential("consumer/example", value, meta);
			expect(credentials.getCredential("consumer/example")).toMatchObject({
				value,
				meta,
			});
			expect(credentials.getCredential("consumer/missing")).toBeUndefined();
			credentials.setCredential("consumer/example", `${value}-rotated`);
			expect(credentials.getCredential("consumer/example")?.value).toBe(
				`${value}-rotated`,
			);
			for (const file of [
				paths.credentialsDbPath,
				`${paths.credentialsDbPath}-wal`,
				paths.dbPath,
			])
				expect(scanFileForBytes(file, value)).toBe(false);
		});
	});

	it("binds the ciphertext to its name so a row moved to another name fails to decrypt", async () => {
		await withStores(({ paths, credentials }) => {
			credentials.setCredential("consumer/source", "fixture-moved-value");
			credentials.setCredential("consumer/target", "fixture-target-value");
			const raw = new Database(paths.credentialsDbPath);
			try {
				raw.run(
					"UPDATE credentials SET (value_ciphertext, value_iv, value_tag) = (SELECT value_ciphertext, value_iv, value_tag FROM credentials WHERE name = 'consumer/source') WHERE name = 'consumer/target'",
				);
			} finally {
				raw.close();
			}
			expect(() => credentials.getCredential("consumer/target")).toThrow();
			expect(credentials.getCredential("consumer/source")?.value).toBe(
				"fixture-moved-value",
			);
		});
	});

	it.each([
		{ value: "x" },
		{ apiSecret: "x" },
		{ accessToken: "x" },
		{ password: "x" },
		{ nested: { refreshToken: "x" } },
		{ expiresAt: "not-a-date" },
		{ scopes: "read" },
	])(
		"rejects secret-like or malformed meta %p without writing",
		async (bad) => {
			await withStores(({ credentials }) => {
				expect(() =>
					credentials.setCredential("consumer/example", "fixture-value", bad),
				).toThrow();
				expect(credentials.listCredentials()).toEqual([]);
			});
		},
	);

	it("lists sorted names and metadata without values, and deletes", async () => {
		await withStores(({ credentials }) => {
			const value = "fixture-listed-value-0b7e44";
			credentials.setCredential("consumer/b", value, meta);
			credentials.setCredential("consumer/a", value);
			const list = credentials.listCredentials();
			expect(list.map((entry) => entry.name)).toEqual([
				"consumer/a",
				"consumer/b",
			]);
			expect(JSON.stringify(list)).not.toContain(value);
			expect(credentials.deleteCredential("consumer/a")).toBe(true);
			expect(credentials.deleteCredential("consumer/a")).toBe(false);
		});
	});
});

describe("CredentialStore grants", () => {
	it("stores only the token hash, verifies, records use, rotates and revokes", async () => {
		await withStores(({ paths, credentials }) => {
			const token = credentials.createCredentialGrant("channel-review");
			expect(Buffer.from(token, "base64url")).toHaveLength(32);
			expect(scanFileForBytes(paths.credentialsDbPath, token)).toBe(false);
			expect(credentials.listCredentialGrants()).toEqual([
				expect.objectContaining({ prefix: "channel-review", lastUsedAt: null }),
			]);
			expect(JSON.stringify(credentials.listCredentialGrants())).not.toContain(
				token,
			);
			expect(credentials.verifyCredentialGrant("channel-review", token)).toBe(
				true,
			);
			expect(credentials.listCredentialGrants()[0].lastUsedAt).not.toBeNull();
			expect(credentials.verifyCredentialGrant("other", token)).toBe(false);
			expect(
				credentials.verifyCredentialGrant("channel-review", `${token}x`),
			).toBe(false);
			const rotated = credentials.createCredentialGrant("channel-review");
			expect(credentials.verifyCredentialGrant("channel-review", token)).toBe(
				false,
			);
			expect(credentials.verifyCredentialGrant("channel-review", rotated)).toBe(
				true,
			);
			expect(credentials.deleteCredentialGrant("channel-review")).toBe(true);
			expect(credentials.verifyCredentialGrant("channel-review", rotated)).toBe(
				false,
			);
			expect(credentials.listCredentialGrants()).toEqual([]);
		});
	});

	it("compares token hashes with the shared constant-time helper", () => {
		const source = readFileSync(
			join(import.meta.dir, "../../src/store/credentials-store.ts"),
			"utf8",
		);
		const verify = source.slice(source.indexOf("verifyCredentialGrant("));
		expect(verify).toContain("tokensEqual(");
		expect(verify.slice(0, verify.indexOf("listCredentialGrants"))).not.toMatch(
			/token_hash\s*===|===\s*hashToken/,
		);
	});
});
