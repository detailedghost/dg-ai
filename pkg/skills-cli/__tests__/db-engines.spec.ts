import { describe, expect, mock, test } from "bun:test";
import {
	buildPgClientOptions,
	pgDescribe,
	pgExplain,
	pgQuery,
	pgSchema,
	pgTables,
	type PgClient,
	type PgQueryResult,
} from "../src/db/engines/postgresql";
import {
	buildConnectionOptions,
	sfDescribe,
	sfExplain,
	sfQuery,
	sfSchema,
	sfTables,
	type SfConnection,
	type SfStatement,
} from "../src/db/engines/snowflake";

function fakePg(...results: PgQueryResult[]) {
	const query = mock(async (_sql: string, _values?: unknown[]) => {
		const result = results.shift();
		if (!result) throw new Error("unexpected query");
		return result;
	});
	return {
		client: {
			connect: async () => {},
			query,
			end: async () => {},
		} as unknown as PgClient,
		query,
	};
}

function fakeSnowflake(
	handler: (sql: string) => {
		rows?: Array<Record<string, unknown>>;
		columns?: string[];
		numRows?: number;
		error?: Error;
	},
) {
	const execute = mock((options: Parameters<SfConnection["execute"]>[0]) => {
		const result = handler(options.sqlText);
		const statement: SfStatement = {
			getColumns: () => result.columns?.map((name) => ({ getName: () => name })),
			getNumRows: () => result.numRows ?? result.rows?.length ?? 0,
		};
		options.complete(result.error, statement, result.rows ?? []);
	});
	const destroy = mock((callback: (error: Error | undefined) => void) =>
		callback(undefined),
	);
	return {
		connection: {
			connect: () => {},
			execute,
			destroy,
			getId: () => "fixture",
		} as unknown as SfConnection,
		execute,
		destroy,
	};
}

describe("PostgreSQL engine", () => {
	test("builds password client options with the legacy host and port defaults", () => {
		expect(
			buildPgClientOptions({
				engine: "postgresql",
				database: "app",
				user: "readonly",
				password: "fixture-password",
			}),
		).toEqual({
			host: "localhost",
			port: 5432,
			database: "app",
			user: "readonly",
			password: "fixture-password",
		});
	});

	test("maps row and write query results", async () => {
		const rows = fakePg({
			fields: [{ name: "id" }, { name: "name" }],
			rows: [{ id: 1, name: "Ada" }],
			rowCount: 1,
		});
		expect(await pgQuery(rows.client, "SELECT id, name FROM users")).toEqual({
			columns: ["id", "name"],
			rows: [[1, "Ada"]],
			totalRows: 1,
		});

		const write = fakePg({ fields: [], rows: [], rowCount: 3 });
		expect(await pgQuery(write.client, "UPDATE users SET active = true")).toEqual({
			columns: [],
			rows: [],
			totalRows: 0,
			rowsAffected: 3,
		});
	});

	test("lists, describes and explains with parameterized metadata queries", async () => {
		const fixture = fakePg(
			{ rows: [{ table_name: "users" }], fields: [] },
			{
				rows: [
					{ column_name: "id", data_type: "integer", is_nullable: "NO", column_default: null },
				],
				fields: [],
			},
			{ rows: [{ estimate: "42" }], fields: [] },
			{ rows: [{ "QUERY PLAN": "Seq Scan on users" }], fields: [] },
		);
		expect(await pgTables(fixture.client, "audit")).toEqual(["users"]);
		expect(await pgDescribe(fixture.client, "users", "audit")).toEqual({
			columns: [{ name: "id", type: "integer", nullable: "NO", defaultVal: "" }],
			rowEstimate: 42,
		});
		expect(await pgExplain(fixture.client, "SELECT * FROM users")).toBe(
			"Seq Scan on users",
		);
		expect(fixture.query.mock.calls[0]?.[1]).toEqual(["audit"]);
	});

	test("freezes the one-query schema JSON shape", async () => {
		const fixture = fakePg({
			fields: [],
			rows: [
				{
					table_name: "users",
					table_schema: "public",
					column_name: "org_id",
					data_type: "integer",
					is_nullable: "NO",
					is_primary_key: false,
					is_foreign_key: true,
					fk_column: "org_id",
					ref_table: "orgs",
					ref_column: "id",
				},
			],
		});
		expect(await pgSchema(fixture.client)).toEqual({
			tables: [
				{
					name: "users",
					schema: "public",
					columns: [
						{
							name: "org_id",
							dataType: "integer",
							nullable: false,
							isPrimaryKey: false,
							isForeignKey: true,
						},
					],
					foreignKeys: [{ column: "org_id", refTable: "orgs", refColumn: "id" }],
				},
			],
		});
		expect(fixture.query).toHaveBeenCalledTimes(1);
	});
});

describe("Snowflake engine", () => {
	test("builds password, JWT and external-browser authentication options", () => {
		expect(
			buildConnectionOptions({
				engine: "snowflake",
				account: "ACCT-ID",
				user: "analyst",
				password: "fixture-password",
			}),
		).toMatchObject({
			account: "ACCT-ID",
			username: "analyst",
			password: "fixture-password",
			schema: "PUBLIC",
		});
		expect(
			buildConnectionOptions({
				engine: "snowflake",
				account: "ACCT-ID",
				user: "svc_account",
				authenticator: "snowflake_jwt",
				privateKeyPath: "/fixture/key.p8",
				passphrase: "fixture-passphrase",
			}),
		).toMatchObject({
			authenticator: "SNOWFLAKE_JWT",
			privateKeyPath: "/fixture/key.p8",
			privateKeyPass: "fixture-passphrase",
		});
		const sso = buildConnectionOptions({
			engine: "snowflake",
			account: "ACCT-ID",
			user: "user@example.test",
			authenticator: "external_browser",
			clientStoreTemporaryCredential: true,
			browserActionTimeout: 300000,
		});
		expect(sso).toMatchObject({
			authenticator: "EXTERNALBROWSER",
			clientStoreTemporaryCredential: true,
			browserActionTimeout: 300000,
		});
		expect(sso.password).toBeUndefined();
		expect(typeof sso.openExternalBrowserCallback).toBe("function");
	});

	test("maps row and write query results through the callback adapter", async () => {
		const rows = fakeSnowflake(() => ({
			columns: ["ID", "NAME"],
			rows: [{ ID: 1, NAME: "Ada" }],
		}));
		expect(await sfQuery(rows.connection, "SELECT ID, NAME FROM USERS")).toEqual({
			columns: ["ID", "NAME"],
			rows: [[1, "Ada"]],
			totalRows: 1,
		});
		const write = fakeSnowflake(() => ({ numRows: 4 }));
		expect(await sfQuery(write.connection, "DELETE FROM USERS")).toEqual({
			columns: [],
			rows: [],
			totalRows: 0,
			rowsAffected: 4,
		});
	});

	test("lists, describes and explains through callback-based execution", async () => {
		const fixture = fakeSnowflake((sql) => {
			if (sql.startsWith("SHOW TABLES IN")) return { rows: [{ name: "USERS" }] };
			if (sql.startsWith("DESCRIBE"))
				return { rows: [{ name: "ID", type: "NUMBER", null: "N", default: null }] };
			if (sql.startsWith("SHOW TABLES LIKE")) return { rows: [{ rows: 21 }] };
			return { rows: [{ content: "TableScan USERS" }] };
		});
		expect(await sfTables(fixture.connection, "RAW")).toEqual(["USERS"]);
		expect(await sfDescribe(fixture.connection, "USERS")).toEqual({
			columns: [{ name: "ID", type: "NUMBER", nullable: "NO", defaultVal: "" }],
			rowEstimate: 21,
		});
		expect(await sfExplain(fixture.connection, "SELECT * FROM USERS")).toBe(
			"TableScan USERS",
		);
	});

	test("logs to stderr instead of silently swallowing a SHOW TABLES LIKE failure", async () => {
		const fixture = fakeSnowflake((sql) => {
			if (sql.startsWith("DESCRIBE"))
				return { rows: [{ name: "ID", type: "NUMBER", null: "N", default: null }] };
			if (sql.startsWith("SHOW TABLES LIKE")) return { error: new Error("insufficient privileges") };
			return { rows: [] };
		});
		const stderr: string[] = [];
		const originalWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string) => {
			stderr.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			const result = await sfDescribe(fixture.connection, "USERS");
			expect(result.rowEstimate).toBeUndefined();
		} finally {
			process.stderr.write = originalWrite;
		}
		expect(stderr.join("")).toContain("insufficient privileges");
	});

	test("freezes the fixed-query schema JSON shape", async () => {
		const fixture = fakeSnowflake((sql) => {
			if (sql.includes("information_schema.columns"))
				return {
					rows: [
						{
							TABLE_NAME: "USERS",
							TABLE_SCHEMA: "PUBLIC",
							COLUMN_NAME: "ORG_ID",
							DATA_TYPE: "NUMBER",
							IS_NULLABLE: "NO",
						},
					],
				};
			if (sql.startsWith("SHOW PRIMARY")) return { rows: [] };
			return {
				rows: [
					{
						fk_table_name: "USERS",
						fk_column_name: "ORG_ID",
						pk_table_name: "ORGS",
						pk_column_name: "ID",
					},
				],
			};
		});
		expect(await sfSchema(fixture.connection)).toEqual({
			tables: [
				{
					name: "USERS",
					schema: "PUBLIC",
					columns: [
						{
							name: "ORG_ID",
							dataType: "NUMBER",
							nullable: false,
							isPrimaryKey: false,
							isForeignKey: true,
						},
					],
					foreignKeys: [{ column: "ORG_ID", refTable: "ORGS", refColumn: "ID" }],
				},
			],
		});
		expect(fixture.execute).toHaveBeenCalledTimes(3);
	});
});
