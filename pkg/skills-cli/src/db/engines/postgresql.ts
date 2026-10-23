import type { ConnectionConfig } from "../credentials";
import type { QueryResult } from "../output";
import type { DbSchemaResult, DbSchemaTable } from "../types";

export interface PgField {
	name: string;
}

export interface PgQueryResult {
	fields?: PgField[];
	rows: Array<Record<string, unknown>>;
	rowCount?: number | null;
}

export interface PgClient {
	connect(): Promise<void>;
	query(sql: string, values?: unknown[]): Promise<PgQueryResult>;
	end(): Promise<void>;
}

interface PgModule {
	Client: new (options: Record<string, unknown>) => PgClient;
}

let pgModule: PgModule | undefined;

function getPg(): PgModule {
	if (!pgModule) pgModule = require("pg") as PgModule;
	return pgModule;
}

export function buildPgClientOptions(
	connection: ConnectionConfig,
): Record<string, unknown> {
	return {
		host: connection.host ?? "localhost",
		port: connection.port ?? 5432,
		database: connection.database,
		user: connection.user,
		password: connection.password,
		ssl: connection.ssl,
	};
}

export async function pgConnect(
	connection: ConnectionConfig,
): Promise<PgClient> {
	const client = new (getPg().Client)(buildPgClientOptions(connection));
	await client.connect();
	return client;
}

export async function pgQuery(
	client: PgClient,
	sql: string,
): Promise<QueryResult> {
	const result = await client.query(sql);
	if (!result.fields || result.fields.length === 0)
		return {
			columns: [],
			rows: [],
			totalRows: 0,
			rowsAffected: result.rowCount ?? 0,
		};

	const columns = result.fields.map((field) => field.name);
	const rows = result.rows.map((row) => columns.map((column) => row[column]));
	return { columns, rows, totalRows: rows.length };
}

export async function pgTest(connection: ConnectionConfig): Promise<string> {
	const client = await pgConnect(connection);
	try {
		const result = await client.query("SELECT version()");
		return `OK: ${result.rows[0]?.version ?? "connected"}`;
	} finally {
		await client.end();
	}
}

export async function pgTables(
	client: PgClient,
	schema = "public",
): Promise<string[]> {
	const result = await client.query(
		`SELECT table_name FROM information_schema.tables
		 WHERE table_schema = $1
		 ORDER BY table_name`,
		[schema],
	);
	return result.rows.map((row) => String(row.table_name));
}

export async function pgDescribe(
	client: PgClient,
	tableName: string,
	schema = "public",
): Promise<{
	columns: Array<{
		name: string;
		type: string;
		nullable: string;
		defaultVal: string;
	}>;
	rowEstimate: number | undefined;
}> {
	const columnsResult = await client.query(
		`SELECT column_name, data_type, is_nullable,
		        column_default
		 FROM information_schema.columns
		 WHERE table_schema = $1 AND table_name = $2
		 ORDER BY ordinal_position`,
		[schema, tableName],
	);
	const columns = columnsResult.rows.map((row) => ({
		name: String(row.column_name),
		type: String(row.data_type),
		nullable: row.is_nullable === "YES" ? "YES" : "NO",
		defaultVal: row.column_default == null ? "" : String(row.column_default),
	}));
	const estimateResult = await client.query(
		`SELECT reltuples::bigint AS estimate
		 FROM pg_class
		 WHERE relname = $1`,
		[tableName],
	);
	const estimate = estimateResult.rows[0]?.estimate;
	const rowEstimate =
		estimate !== undefined && Number(estimate) >= 0 ? Number(estimate) : undefined;
	return { columns, rowEstimate };
}

export async function pgSchema(
	client: PgClient,
	schema = "public",
): Promise<DbSchemaResult> {
	const result = await client.query(
		`SELECT
			c.table_name,
			c.table_schema,
			c.column_name,
			c.data_type,
			c.is_nullable,
			(pk.column_name IS NOT NULL) AS is_primary_key,
			(fk.column_name IS NOT NULL) AS is_foreign_key,
			fk.column_name AS fk_column,
			fk.ref_table AS ref_table,
			fk.ref_column AS ref_column
		 FROM information_schema.columns c
		 LEFT JOIN (
			SELECT ku.table_schema, ku.table_name, ku.column_name
			FROM information_schema.table_constraints tc
			JOIN information_schema.key_column_usage ku
				ON tc.constraint_name = ku.constraint_name
				AND tc.table_schema = ku.table_schema
			WHERE tc.constraint_type = 'PRIMARY KEY'
		 ) pk ON pk.table_schema = c.table_schema
			AND pk.table_name = c.table_name
			AND pk.column_name = c.column_name
		 LEFT JOIN (
			SELECT
				kcu1.table_schema,
				kcu1.table_name,
				kcu1.column_name,
				kcu2.table_name AS ref_table,
				kcu2.column_name AS ref_column
			FROM information_schema.referential_constraints rc
			JOIN information_schema.key_column_usage kcu1
				ON kcu1.constraint_name = rc.constraint_name
				AND kcu1.constraint_schema = rc.constraint_schema
			JOIN information_schema.key_column_usage kcu2
				ON kcu2.constraint_name = rc.unique_constraint_name
				AND kcu2.constraint_schema = rc.unique_constraint_schema
				AND kcu2.ordinal_position = kcu1.ordinal_position
		 ) fk ON fk.table_schema = c.table_schema
			AND fk.table_name = c.table_name
			AND fk.column_name = c.column_name
		 WHERE c.table_schema = $1
		 ORDER BY c.table_name, c.ordinal_position`,
		[schema],
	);

	const tables = new Map<string, DbSchemaTable>();
	for (const row of result.rows) {
		const tableName = String(row.table_name);
		let table = tables.get(tableName);
		if (!table) {
			table = {
				name: tableName,
				schema: String(row.table_schema),
				columns: [],
				foreignKeys: [],
			};
			tables.set(tableName, table);
		}
		table.columns.push({
			name: String(row.column_name),
			dataType: String(row.data_type),
			nullable: row.is_nullable === "YES",
			isPrimaryKey: Boolean(row.is_primary_key),
			isForeignKey: Boolean(row.is_foreign_key),
		});
		if (row.is_foreign_key && row.fk_column)
			table.foreignKeys.push({
				column: String(row.fk_column),
				refTable: String(row.ref_table),
				refColumn: String(row.ref_column),
			});
	}
	return { tables: [...tables.values()] };
}

export async function pgExplain(client: PgClient, sql: string): Promise<string> {
	const result = await client.query(`EXPLAIN ${sql}`);
	return result.rows.map((row) => String(row["QUERY PLAN"])).join("\n");
}
