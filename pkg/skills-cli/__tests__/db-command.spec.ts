import { describe, expect, mock, test } from "bun:test";
import type { CredentialRecord, CredentialSummary } from "@dg/common";
import type { DbCredentialClient } from "../src/db/credentials";
import type { PgClient } from "../src/db/engines/postgresql";
import type { SfConnection } from "../src/db/engines/snowflake";
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
	pgExplain?: DbDeps["pgExplain"];
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
	const pgExplain = options.pgExplain ?? mock(async () => "plan");
	const spec = createDbSpec({
		createCredentialClient: () => credentialClient,
		readSqlFile: options.readSqlFile ?? (async () => "SELECT 1"),
		stdout: (line) => stdout.push(line),
		stderr: (line) => stderr.push(line),
		pgConnect,
		pgQuery,
		pgExplain,
	});
	return {
		spec,
		stdout,
		stderr,
		close,
		end,
		pgConnect,
		pgQuery,
		pgExplain,
		client,
		credentialClient,
	};
}

function snowflakeCredentialRecord(): CredentialRecord {
	return {
		value: "fixture-password",
		meta: { engine: "snowflake", account: "acme", user: "readonly" },
		updatedAt: "2026-01-01T00:00:00Z",
	};
}

function snowflakeHarness(options: {
	record?: CredentialRecord;
	sfExplain?: DbDeps["sfExplain"];
}) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const close = mock(() => {});
	const connection = {} as unknown as SfConnection;
	const credentialClient: DbCredentialClient = {
		get: mock(async () => options.record),
		list: mock(async () => []),
		close,
	};
	const sfConnect = mock(async () => connection);
	const sfExplain = options.sfExplain ?? mock(async () => "plan");
	const sfDestroy = mock(async () => {});
	const spec = createDbSpec({
		createCredentialClient: () => credentialClient,
		stdout: (line) => stdout.push(line),
		stderr: (line) => stderr.push(line),
		sfConnect,
		sfExplain,
		sfDestroy,
	});
	return {
		spec,
		stdout,
		stderr,
		close,
		sfConnect,
		sfExplain,
		sfDestroy,
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

	test("accepts a positional SQL argument that starts with a hyphen when passed after --", async () => {
		const fixture = harness({ record: credentialRecord() });
		const sql = "-- find active users\nSELECT 1";
		const code = await fixture.spec.subcommands.query?.run(["my-pg", "--", sql], {
			json: false,
			help: false,
		});
		expect(code).toBeUndefined();
		expect(fixture.pgQuery).toHaveBeenCalledWith(fixture.client, sql);
	});

	test("rejects an unrecognized flag with a clear error instead of swallowing the SQL text", async () => {
		const fixture = harness({ record: credentialRecord() });
		const code = await fixture.spec.subcommands.query?.run(
			["my-pg", "--typo-flag", "SELECT 1"],
			{ json: false, help: false },
		);
		expect(code).toBe(1);
		expect(fixture.stderr[0]).toContain("--typo-flag");
		expect(fixture.pgQuery).not.toHaveBeenCalled();
	});

	test("a flag placed before the SQL positional still works", async () => {
		const fixture = harness({ record: credentialRecord() });
		const code = await fixture.spec.subcommands.query?.run(
			["my-pg", "--write", "DELETE FROM users"],
			{ json: false, help: false },
		);
		expect(code).toBeUndefined();
		expect(fixture.pgQuery).toHaveBeenCalledWith(fixture.client, "DELETE FROM users");
	});

	test("rejects a non-numeric --limit with a clear error instead of silently emptying the result", async () => {
		const fixture = harness({ record: credentialRecord() });
		const code = await fixture.spec.subcommands.query?.run(
			["my-pg", "SELECT 1", "--limit", "abc"],
			{ json: false, help: false },
		);
		expect(code).toBe(1);
		expect(fixture.stderr).toEqual([
			"ERROR: --limit must be a non-negative integer",
		]);
		expect(fixture.credentialClient.get).not.toHaveBeenCalled();
	});

	test("rejects a non-numeric --max-cell with a clear error instead of truncating every cell", async () => {
		const fixture = harness({ record: credentialRecord() });
		const code = await fixture.spec.subcommands.query?.run(
			["my-pg", "SELECT 1", "--max-cell", "abc"],
			{ json: false, help: false },
		);
		expect(code).toBe(1);
		expect(fixture.stderr).toEqual([
			"ERROR: --max-cell must be a non-negative integer",
		]);
		expect(fixture.credentialClient.get).not.toHaveBeenCalled();
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

	test("blocks a smuggled second statement in explain without --write (postgresql)", async () => {
		const fixture = harness({ record: credentialRecord() });
		const code = await fixture.spec.subcommands.explain?.run(
			["my-pg", "SELECT 1; DROP TABLE x"],
			{ json: false, help: false },
		);
		expect(code).toBe(1);
		expect(fixture.stderr).toEqual([
			"BLOCKED: multiple statements detected — use --write to allow",
		]);
		expect(fixture.pgExplain).not.toHaveBeenCalled();
		expect(fixture.end).toHaveBeenCalledTimes(1);
	});

	test("--write allows a multi-statement explain (postgresql)", async () => {
		const fixture = harness({ record: credentialRecord() });
		const code = await fixture.spec.subcommands.explain?.run(
			["my-pg", "SELECT 1; DROP TABLE x", "--write"],
			{ json: false, help: false },
		);
		expect(code).toBeUndefined();
		expect(fixture.pgExplain).toHaveBeenCalledWith(
			fixture.client,
			"SELECT 1; DROP TABLE x",
		);
	});

	test("blocks a smuggled second statement in explain without --write (snowflake)", async () => {
		const fixture = snowflakeHarness({ record: snowflakeCredentialRecord() });
		const code = await fixture.spec.subcommands.explain?.run(
			["my-sf", "SELECT 1; DROP TABLE x"],
			{ json: false, help: false },
		);
		expect(code).toBe(1);
		expect(fixture.stderr).toEqual([
			"BLOCKED: multiple statements detected — use --write to allow",
		]);
		expect(fixture.sfExplain).not.toHaveBeenCalled();
		expect(fixture.sfDestroy).toHaveBeenCalledTimes(1);
	});

	test("--write allows a multi-statement explain (snowflake)", async () => {
		const fixture = snowflakeHarness({ record: snowflakeCredentialRecord() });
		const code = await fixture.spec.subcommands.explain?.run(
			["my-sf", "SELECT 1; DROP TABLE x", "--write"],
			{ json: false, help: false },
		);
		expect(code).toBeUndefined();
		expect(fixture.sfExplain).toHaveBeenCalled();
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
