import { describe, expect, mock, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialRecord, CredentialSummary } from "@dg/common";
import {
	type DbCredentialClient,
	getConnection,
	listConnections,
} from "../src/db/credentials";

function fakeClient(options: {
	record?: CredentialRecord;
	entries?: CredentialSummary[];
}) {
	const get = mock(async () => options.record);
	const list = mock(async () => options.entries ?? []);
	const close = mock(() => {});
	return { client: { get, list, close } satisfies DbCredentialClient, get, list };
}

describe("credential-backed database connections", () => {
	test("maps a PostgreSQL credential value to the password", async () => {
		const fixture = fakeClient({
			record: {
				value: "fixture-password",
				meta: {
					engine: "postgresql",
					host: "db.example.test",
					port: "5433",
					database: "app",
					user: "readonly",
				},
				updatedAt: "2026-01-01T00:00:00Z",
			},
		});
		expect(await getConnection(fixture.client, "my-pg")).toEqual({
			engine: "postgresql",
			host: "db.example.test",
			port: 5433,
			database: "app",
			schema: undefined,
			user: "readonly",
			account: undefined,
			warehouse: undefined,
			role: undefined,
			authenticator: undefined,
			clientStoreTemporaryCredential: undefined,
			browserActionTimeout: undefined,
			password: "fixture-password",
		});
		expect(fixture.get).toHaveBeenCalledWith("db/my-pg");
	});

	test("never maps the external-browser placeholder to a password", async () => {
		const fixture = fakeClient({
			record: {
				value: "external_browser",
				meta: {
					engine: "snowflake",
					account: "ACCT-ID",
					user: "user@example.test",
					authenticator: "external_browser",
					clientStoreTemporaryCredential: "true",
					browserActionTimeout: "300000",
				},
				updatedAt: "2026-01-01T00:00:00Z",
			},
		});
		const connection = await getConnection(fixture.client, "my-sf");
		expect(connection).toMatchObject({
			engine: "snowflake",
			authenticator: "external_browser",
			clientStoreTemporaryCredential: true,
			browserActionTimeout: 300000,
		});
		expect(connection.password).toBeUndefined();
		expect(connection.passphrase).toBeUndefined();
	});

	test("expands a JWT key path, checks its mode and maps the value to the passphrase", async () => {
		const root = mkdtempSync(join(tmpdir(), "db-key-"));
		const key = join(root, "key.p8");
		try {
			writeFileSync(key, "fixture-key");
			chmodSync(key, 0o400);
			const fixture = fakeClient({
				record: {
					value: "fixture-passphrase",
					meta: {
						engine: "snowflake",
						account: "ACCT-ID",
						user: "svc_account",
						authenticator: "snowflake_jwt",
						privateKeyPath: key,
					},
					updatedAt: "2026-01-01T00:00:00Z",
				},
			});
			expect(await getConnection(fixture.client, "my-sf-key")).toMatchObject({
				privateKeyPath: key,
				passphrase: "fixture-passphrase",
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects a private key readable by group or others", async () => {
		const root = mkdtempSync(join(tmpdir(), "db-key-"));
		const key = join(root, "key.p8");
		try {
			writeFileSync(key, "fixture-key");
			chmodSync(key, 0o644);
			const fixture = fakeClient({
				record: {
					value: "fixture-passphrase",
					meta: {
						engine: "snowflake",
						account: "ACCT-ID",
						user: "svc_account",
						privateKeyPath: key,
					},
					updatedAt: "2026-01-01T00:00:00Z",
				},
			});
			await expect(getConnection(fixture.client, "my-sf-key")).rejects.toThrow(
				/permissions 644 — expected 600 or 400/,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("reports known db connection names when a credential is absent", async () => {
		const fixture = fakeClient({
			entries: [
				{ name: "db/my-pg", meta: {}, updatedAt: "2026-01-01T00:00:00Z" },
				{ name: "ticket/jira", meta: {}, updatedAt: "2026-01-01T00:00:00Z" },
			],
		});
		await expect(getConnection(fixture.client, "missing")).rejects.toThrow(
			'connection "missing" not found — available: my-pg',
		);
	});

	test("lists db metadata without calling get", async () => {
		const fixture = fakeClient({
			entries: [
				{
					name: "db/my-pg",
					meta: { engine: "postgresql", host: "localhost", port: "5432", database: "app" },
					updatedAt: "2026-01-01T00:00:00Z",
				},
				{
					name: "db/my-sf",
					meta: { engine: "snowflake", account: "ACCT-ID", database: "ANALYTICS" },
					updatedAt: "2026-01-01T00:00:00Z",
				},
			],
		});
		expect(await listConnections(fixture.client)).toEqual([
			{ name: "my-pg", engine: "postgresql", target: "localhost:5432/app" },
			{ name: "my-sf", engine: "snowflake", target: "ACCT-ID/ANALYTICS" },
		]);
		expect(fixture.get).not.toHaveBeenCalled();
	});

	test("rejects invalid typed metadata before creating an engine client", async () => {
		const fixture = fakeClient({
			record: {
				value: "fixture-password",
				meta: { engine: "postgresql", port: "many", database: "app", user: "readonly" },
				updatedAt: "2026-01-01T00:00:00Z",
			},
		});
		await expect(getConnection(fixture.client, "my-pg")).rejects.toThrow(
			/invalid port metadata/,
		);
	});
});
