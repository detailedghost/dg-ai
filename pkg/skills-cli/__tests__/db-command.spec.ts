import { describe, expect, mock, test } from "bun:test";
import type { CredentialRecord, CredentialSummary } from "@dg/common";
import type { DbCredentialClient } from "../src/db/credentials";
import type { PgClient } from "../src/db/engines/postgresql";
import { createDbSpec, type DbDeps } from "../src/db";

function credentialRecord(
	meta: CredentialRecord["meta"] = {
		engine: "postgresql",
		database: "app",
		user: "readonly",
	},
): CredentialRecord {
	return {
		value: "fixture-password",
		meta,
		updatedAt: "2026-01-01T00:00:00Z",
	};
}

function harness(options: {
	record?: CredentialRecord;
	entries?: CredentialSummary[];
	readSqlFile?: DbDeps["readSqlFile"];
	pgQuery?: DbDeps["pgQuery"];
}) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const close = mock(() => {});
	const end = mock(async () => {});
	const client = {
		connect: async () => {},
		query: async () => ({ rows: [], fields: [], rowCount: 0 }),
		end,
	} satisfies PgClient;
	const credentialClient: DbCredentialClient = {
		get: mock(async () => options.record),
		list: mock(async () => options.entries ?? []),
		close,
	};
	const pgConnect = mock(async () => client);
	const pgQuery =
		options.pgQuery ??
		mock(async () => ({ columns: ["id"], rows: [[1], [2]], totalRows: 2 }));
	const spec = createDbSpec({
		createCredentialClient: () => credentialClient,
		readSqlFile: options.readSqlFile ?? (async () => "SELECT 1"),
		stdout: (line) => stdout.push(line),
		stderr: (line) => stderr.push(line),
		pgConnect,
		pgQuery,
	});
	return {
		spec,
		stdout,
		stderr,
		close,
		end,
		pgConnect,
		pgQuery,
		client,
		credentialClient,
	};
}

describe("db command specification", () => {
	test("reads query SQL from a file and applies interleaved output flags", async () => {
		const readSqlFile = mock(async () => " SELECT id FROM users \n");
		const fixture = harness({ record: credentialRecord(), readSqlFile });
		const code = await fixture.spec.subcommands.query?.run(
			["my-pg", "--format", "json", "-f", "/fixture/query.sql", "--limit", "1"],
			{ json: false, help: false },
		);
		expect(code).toBeUndefined();
		expect(readSqlFile).toHaveBeenCalledWith("/fixture/query.sql");
		expect(fixture.pgQuery).toHaveBeenCalledWith(
			fixture.client,
			"SELECT id FROM users",
		);
		expect(fixture.stdout).toEqual(['ROWS: 1/2\n{"id":"1"}']);
		expect(fixture.close).toHaveBeenCalledTimes(1);
		expect(fixture.end).toHaveBeenCalledTimes(1);
	});

	test("blocks SELECT INTO and still closes both clients", async () => {
		const fixture = harness({ record: credentialRecord() });
		const code = await fixture.spec.subcommands.query?.run(
			["my-pg", "SELECT id INTO archive FROM users"],
			{ json: false, help: false },
		);
		expect(code).toBe(1);
		expect(fixture.stderr).toEqual([
			"BLOCKED: SELECT INTO creates a table — use --write",
		]);
		expect(fixture.pgQuery).not.toHaveBeenCalled();
		expect(fixture.close).toHaveBeenCalledTimes(1);
		expect(fixture.end).toHaveBeenCalledTimes(1);
	});

	test("--write executes a write and prints affected rows", async () => {
		const pgQuery = mock(async () => ({
			columns: [],
			rows: [],
			totalRows: 0,
			rowsAffected: 4,
		}));
		const fixture = harness({ record: credentialRecord(), pgQuery });
		const code = await fixture.spec.subcommands.query?.run(
			["my-pg", "DELETE FROM users", "--write"],
			{ json: false, help: false },
		);
		expect(code).toBeUndefined();
		expect(fixture.stdout).toEqual(["OK: 4 rows affected"]);
	});

	test("redacts an engine error and exits 1", async () => {
		const pgQuery = mock(async () => {
			throw new Error("password=fixture-password rejected");
		});
		const fixture = harness({ record: credentialRecord(), pgQuery });
		const code = await fixture.spec.subcommands.query?.run(
			["my-pg", "SELECT 1"],
			{ json: false, help: false },
		);
		expect(code).toBe(1);
		expect(fixture.stderr).toEqual(["ERROR: [REDACTED] rejected"]);
		expect(fixture.stderr.join("\n")).not.toContain("fixture-password");
		expect(fixture.end).toHaveBeenCalledTimes(1);
	});

	test("closes clients when reading a query file fails", async () => {
		const fixture = harness({
			record: credentialRecord(),
			readSqlFile: async () => {
				throw new Error("file not found");
			},
		});
		const code = await fixture.spec.subcommands.query?.run(
			["my-pg", "-f", "/fixture/missing.sql"],
			{ json: false, help: false },
		);
		expect(code).toBe(1);
		expect(fixture.stderr).toEqual(["ERROR: file not found"]);
		expect(fixture.close).toHaveBeenCalledTimes(1);
		expect(fixture.end).toHaveBeenCalledTimes(1);
	});

	test("reports missing connections with the legacy error shape", async () => {
		const fixture = harness({
			entries: [
				{ name: "db/known", meta: {}, updatedAt: "2026-01-01T00:00:00Z" },
			],
		});
		const code = await fixture.spec.subcommands.test?.run(["missing"], {
			json: false,
			help: false,
		});
		expect(code).toBe(1);
		expect(fixture.stderr).toEqual([
			'ERROR: connection "missing" not found — available: known',
		]);
		expect(fixture.pgConnect).not.toHaveBeenCalled();
	});

	test("connections lists only db metadata and never reads values", async () => {
		const fixture = harness({
			entries: [
				{
					name: "db/my-pg",
					meta: { engine: "postgresql", database: "app" },
					updatedAt: "2026-01-01T00:00:00Z",
				},
			],
		});
		const code = await fixture.spec.subcommands.connections?.run([], {
			json: false,
			help: false,
		});
		expect(code).toBeUndefined();
		expect(fixture.stdout).toEqual([
			"CONNECTIONS: 1\nname\tengine\ttarget\nmy-pg\tpostgresql\tlocalhost:5432/app",
		]);
		expect(fixture.credentialClient.get).not.toHaveBeenCalled();
	});
});
