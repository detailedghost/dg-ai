import type { ConnectionOptions } from "snowflake-sdk";
import { isWSL, tryOpen } from "@dg/common/node";
import type { ConnectionConfig } from "../credentials";
import type { QueryResult } from "../output";
import type { DbSchemaForeignKey, DbSchemaResult, DbSchemaTable } from "../types";

let snowflakeSdk: typeof import("snowflake-sdk") | undefined;

function getSnowflakeSdk(): typeof import("snowflake-sdk") {
	if (!snowflakeSdk) {
		snowflakeSdk = require("snowflake-sdk") as typeof import("snowflake-sdk");
		snowflakeSdk.configure({ logLevel: "OFF" });
	}
	return snowflakeSdk;
}

export interface SfStatement {
	getColumns(): Array<{ getName(): string }> | undefined;
	getNumRows(): number;
}

export interface SfConnection {
	connect(callback: (error: Error | undefined, connection: SfConnection) => void): void;
	execute(options: {
		sqlText: string;
		binds?: unknown[];
		parameters?: Record<string, unknown>;
		complete: (
			error: Error | undefined,
			statement: SfStatement,
			rows?: unknown[],
		) => void;
	}): void;
	destroy(callback: (error: Error | undefined) => void): void;
	getId(): string;
}

function connectAsync(connection: SfConnection): Promise<SfConnection> {
	return new Promise((resolve, reject) => {
		connection.connect((error, connected) => {
			if (error) reject(error);
			else resolve(connected);
		});
	});
}

export function executeAsync(
	connection: SfConnection,
	sqlText: string,
	binds?: unknown[],
): Promise<{ statement: SfStatement; rows: unknown[] }> {
	return new Promise((resolve, reject) => {
		connection.execute({
			sqlText,
			binds,
			parameters: { MULTI_STATEMENT_COUNT: 1 },
			complete: (error, statement, rows = []) => {
				if (error) reject(error);
				else resolve({ statement, rows });
			},
		});
	});
}

export function sfDestroy(connection: SfConnection): Promise<void> {
	return new Promise((resolve, reject) => {
		connection.destroy((error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

export function announceSsoUrl(url: string): void {
	const hint = isWSL() ? " (WSL: opening via the Windows host)" : "";
	process.stderr.write(
		`\nSnowflake SSO login required${hint}.\nIf no browser opens, open this URL manually:\n\n  ${url}\n\nWaiting for the browser callback…\n\n`,
	);
}

export function buildConnectionOptions(
	config: ConnectionConfig,
): ConnectionOptions {
	const options: ConnectionOptions = {
		account: config.account,
		username: config.user,
		database: config.database,
		schema: config.schema ?? "PUBLIC",
		warehouse: config.warehouse,
		role: config.role,
	};
	const authenticator = config.authenticator?.toLowerCase();
	if (
		authenticator === "external_browser" ||
		authenticator === "externalbrowser"
	) {
		options.authenticator = "EXTERNALBROWSER";
		if (config.clientStoreTemporaryCredential)
			options.clientStoreTemporaryCredential = true;
		options.openExternalBrowserCallback = (url: string) => {
			announceSsoUrl(url);
			void tryOpen(url);
		};
		if (config.browserActionTimeout !== undefined)
			options.browserActionTimeout = config.browserActionTimeout;
	} else if (authenticator === "snowflake_jwt" || config.privateKeyPath) {
		options.authenticator = "SNOWFLAKE_JWT";
		options.privateKeyPath = config.privateKeyPath;
		if (config.passphrase) options.privateKeyPass = config.passphrase;
	} else {
		options.password = config.password;
	}
	return options;
}

export async function sfConnect(
	config: ConnectionConfig,
): Promise<SfConnection> {
	const connection = getSnowflakeSdk().createConnection(
		buildConnectionOptions(config),
	) as unknown as SfConnection;
	return connectAsync(connection);
}

export async function sfQuery(
	connection: SfConnection,
	sql: string,
): Promise<QueryResult> {
	const { statement, rows } = await executeAsync(connection, sql);
	const columns = (statement.getColumns() ?? []).map((column) => column.getName());
	if (columns.length === 0)
		return {
			columns: [],
			rows: [],
			totalRows: 0,
			rowsAffected: statement.getNumRows(),
		};
	const dataRows = rows.map((row) => {
		const record = row as Record<string, unknown>;
		return columns.map((column) => record[column]);
	});
	return { columns, rows: dataRows, totalRows: dataRows.length };
}

export async function sfTest(config: ConnectionConfig): Promise<string> {
	const connection = await sfConnect(config);
	try {
		const { rows } = await executeAsync(
			connection,
			"SELECT CURRENT_VERSION() AS v",
		);
		const version = (rows[0] as Record<string, unknown> | undefined)?.v;
		return `OK: Snowflake ${version ?? "connected"}`;
	} finally {
		await sfDestroy(connection);
	}
}

export async function sfTables(
	connection: SfConnection,
	schema = "PUBLIC",
): Promise<string[]> {
	const { rows } = await executeAsync(
		connection,
		`SHOW TABLES IN SCHEMA ${identifierForInterpolation(schema)}`,
	);
	return rows.map((row) => String((row as Record<string, unknown>).name));
}

export async function sfDescribe(
	connection: SfConnection,
	tableName: string,
): Promise<{
	columns: Array<{
		name: string;
		type: string;
		nullable: string;
		defaultVal: string;
	}>;
	rowEstimate: number | undefined;
}> {
	const { rows } = await executeAsync(
		connection,
		`DESCRIBE TABLE ${identifierForInterpolation(tableName)}`,
	);
	const columns = rows.map((row) => {
		const record = row as Record<string, unknown>;
		return {
			name: String(record.name),
			type: String(record.type),
			nullable: record.null === "Y" ? "YES" : "NO",
			defaultVal: record.default == null ? "" : String(record.default),
		};
	});
	let rowEstimate: number | undefined;
	try {
		const result = await executeAsync(
			connection,
			`SHOW TABLES LIKE '${tableName.replaceAll("'", "''")}'`,
		);
		const value = (result.rows[0] as Record<string, unknown> | undefined)?.rows;
		if (value !== undefined) rowEstimate = Number(value);
	} catch (err) {
		process.stderr.write(
			`dg-skills db: could not estimate the row count for ${tableName} via SHOW TABLES LIKE (${(err as Error).message})\n`,
		);
		rowEstimate = undefined;
	}
	return { columns, rowEstimate };
}

function quoteIdentifier(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}

const BARE_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/** Unquoted Snowflake identifiers fold to uppercase; only quote names that need it, so the common unquoted-uppercase case keeps matching as before. */
function identifierForInterpolation(name: string): string {
	return BARE_IDENTIFIER_RE.test(name) ? name : quoteIdentifier(name);
}

export async function sfSchema(
	connection: SfConnection,
	schema = "PUBLIC",
): Promise<DbSchemaResult> {
	const schemaIdentifier = quoteIdentifier(schema);
	const { rows: columnRows } = await executeAsync(
		connection,
		`SELECT table_name, table_schema, column_name, data_type, is_nullable
		 FROM information_schema.columns
		 WHERE table_schema = ?
		 ORDER BY table_name, ordinal_position`,
		[schema],
	);
	const tables = new Map<string, DbSchemaTable>();
	for (const row of columnRows) {
		const record = row as Record<string, unknown>;
		const tableName = String(record.TABLE_NAME);
		let table = tables.get(tableName);
		if (!table) {
			table = {
				name: tableName,
				schema: String(record.TABLE_SCHEMA),
				columns: [],
				foreignKeys: [],
			};
			tables.set(tableName, table);
		}
		table.columns.push({
			name: String(record.COLUMN_NAME),
			dataType: String(record.DATA_TYPE),
			nullable: record.IS_NULLABLE === "YES",
			isPrimaryKey: false,
			isForeignKey: false,
		});
	}
	if (tables.size === 0) return { tables: [] };

	const { rows: primaryKeyRows } = await executeAsync(
		connection,
		`SHOW PRIMARY KEYS IN SCHEMA ${schemaIdentifier}`,
	);
	const primaryKeys = new Set(
		primaryKeyRows.map((row) => {
			const record = row as Record<string, unknown>;
			return `${record.table_name}.${record.column_name}`;
		}),
	);
	const { rows: foreignKeyRows } = await executeAsync(
		connection,
		`SHOW IMPORTED KEYS IN SCHEMA ${schemaIdentifier}`,
	);
	const foreignKeysByTable = new Map<string, DbSchemaForeignKey[]>();
	for (const row of foreignKeyRows) {
		const record = row as Record<string, unknown>;
		const tableName = String(record.fk_table_name);
		const foreignKey = {
			column: String(record.fk_column_name),
			refTable: String(record.pk_table_name),
			refColumn: String(record.pk_column_name),
		};
		foreignKeysByTable.set(tableName, [
			...(foreignKeysByTable.get(tableName) ?? []),
			foreignKey,
		]);
	}
	for (const table of tables.values()) {
		const foreignKeys = foreignKeysByTable.get(table.name) ?? [];
		table.foreignKeys = foreignKeys;
		const foreignKeyColumns = new Set(foreignKeys.map((key) => key.column));
		for (const column of table.columns) {
			column.isPrimaryKey = primaryKeys.has(`${table.name}.${column.name}`);
			column.isForeignKey = foreignKeyColumns.has(column.name);
		}
	}
	return { tables: [...tables.values()] };
}

export async function sfExplain(
	connection: SfConnection,
	sql: string,
): Promise<string> {
	const { rows } = await executeAsync(connection, `EXPLAIN ${sql}`);
	return rows
		.map((row) => {
			const record = row as Record<string, unknown>;
			return String(
				record.content ?? record.CONTENT ?? record["QUERY PLAN"] ?? JSON.stringify(record),
			);
		})
		.join("\n");
}
