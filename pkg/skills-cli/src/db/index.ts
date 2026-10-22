import { parseNonNegativeInteger } from "@dg/common";
import type { CommandSpec } from "../utils/legacy-command";
import {
	createDbCredentialClient,
	type DbCredentialClient,
	getConnection,
	listConnections,
} from "./credentials";
import {
	pgConnect,
	pgDescribe,
	pgExplain,
	pgQuery,
	pgSchema,
	pgTables,
	pgTest,
} from "./engines/postgresql";
import {
	sfConnect,
	sfDescribe,
	sfDestroy,
	sfExplain,
	sfQuery,
	sfSchema,
	sfTables,
	sfTest,
} from "./engines/snowflake";
import {
	formatConnections,
	formatDescribe,
	formatError,
	formatExplain,
	formatQueryResult,
	formatTables,
	formatWriteResult,
	type OutputFormat,
} from "./output";
import { classifySql } from "./safety";

interface ParsedArgs {
	positional: string[];
	write: boolean;
	limit: number | null;
	format: OutputFormat | null;
	maxCell: number | null;
	schema: string;
	sqlFile: string;
}

export interface DbDeps {
	createCredentialClient(): DbCredentialClient;
	readSqlFile(path: string): Promise<string>;
	stdout(line: string): void;
	stderr(line: string): void;
	pgConnect: typeof pgConnect;
	pgQuery: typeof pgQuery;
	pgTables: typeof pgTables;
	pgDescribe: typeof pgDescribe;
	pgExplain: typeof pgExplain;
	pgSchema: typeof pgSchema;
	pgTest: typeof pgTest;
	sfConnect: typeof sfConnect;
	sfQuery: typeof sfQuery;
	sfTables: typeof sfTables;
	sfDescribe: typeof sfDescribe;
	sfExplain: typeof sfExplain;
	sfSchema: typeof sfSchema;
	sfTest: typeof sfTest;
	sfDestroy: typeof sfDestroy;
}

const defaultDeps: DbDeps = {
	createCredentialClient: createDbCredentialClient,
	readSqlFile: (path) => Bun.file(path).text(),
	stdout: (line) => process.stdout.write(`${line}\n`),
	stderr: (line) => process.stderr.write(`${line}\n`),
	pgConnect,
	pgQuery,
	pgTables,
	pgDescribe,
	pgExplain,
	pgSchema,
	pgTest,
	sfConnect,
	sfQuery,
	sfTables,
	sfDescribe,
	sfExplain,
	sfSchema,
	sfTest,
	sfDestroy,
};

function parseArgs(args: string[]): ParsedArgs {
	const parsed: ParsedArgs = {
		positional: [],
		write: false,
		limit: null,
		format: null,
		maxCell: null,
		schema: "",
		sqlFile: "",
	};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] ?? "";
		if (arg === "--write") parsed.write = true;
		else if (arg === "--limit" && i + 1 < args.length)
			parsed.limit = parseNonNegativeInteger("--limit", args[++i] ?? "");
		else if (arg === "--format" && i + 1 < args.length)
			parsed.format = (args[++i] ?? "") as OutputFormat;
		else if (arg === "--max-cell" && i + 1 < args.length)
			parsed.maxCell = parseNonNegativeInteger("--max-cell", args[++i] ?? "");
		else if (arg === "--schema" && i + 1 < args.length)
			parsed.schema = args[++i] ?? "";
		else if (arg === "-f" && i + 1 < args.length)
			parsed.sqlFile = args[++i] ?? "";
		else if (!arg.startsWith("-")) parsed.positional.push(arg);
	}
	return parsed;
}

async function safely(
	deps: DbDeps,
	run: () => Promise<number | void>,
): Promise<number | void> {
	try {
		return await run();
	} catch (error) {
		deps.stderr(formatError(error));
		return 1;
	}
}

async function loadConnection(
	deps: DbDeps,
	name: string,
): ReturnType<typeof getConnection> {
	const client = deps.createCredentialClient();
	try {
		return await getConnection(client, name);
	} finally {
		client.close();
	}
}

async function resolveSql(
	parsed: ParsedArgs,
	deps: DbDeps,
): Promise<string> {
	const sql = parsed.sqlFile
		? (await deps.readSqlFile(parsed.sqlFile)).trim()
		: (parsed.positional[1] ?? "");
	if (!sql) throw new Error("SQL query required");
	return sql;
}

type ConnectionVerb = "query" | "tables" | "describe" | "explain" | "schema";

async function runPostgresql(
	verb: ConnectionVerb,
	connection: Awaited<ReturnType<typeof getConnection>>,
	parsed: ParsedArgs,
	deps: DbDeps,
): Promise<number | void> {
	const client = await deps.pgConnect(connection);
	try {
		if (verb === "query") {
			const sql = await resolveSql(parsed, deps);
			const safety = classifySql(sql, parsed.write);
			if (!safety.allowed) {
				deps.stderr(`BLOCKED: ${safety.reason}`);
				return 1;
			}
			const result = await deps.pgQuery(client, sql);
			deps.stdout(
				result.columns.length === 0 && result.rowsAffected !== undefined
					? formatWriteResult(result.rowsAffected)
					: formatQueryResult(
							result,
							parsed.format ?? "tsv",
							parsed.maxCell ?? 200,
							parsed.limit ?? 50,
						),
			);
			return;
		}
		if (verb === "tables") {
			const schema = parsed.schema || "public";
			deps.stdout(formatTables(await deps.pgTables(client, schema), schema));
			return;
		}
		if (verb === "describe") {
			const table = parsed.positional[1];
			if (!table) throw new Error("table name required");
			const info = await deps.pgDescribe(
				client,
				table,
				parsed.schema || "public",
			);
			deps.stdout(formatDescribe(table, info.columns, info.rowEstimate));
			return;
		}
		if (verb === "explain") {
			const sql = await resolveSql(parsed, deps);
			const safety = classifySql(sql, parsed.write);
			if (!safety.allowed) {
				deps.stderr(`BLOCKED: ${safety.reason}`);
				return 1;
			}
			deps.stdout(formatExplain(await deps.pgExplain(client, sql)));
			return;
		}
		deps.stdout(
			JSON.stringify(await deps.pgSchema(client, parsed.schema || "public")),
		);
	} finally {
		await client.end().catch(() => undefined);
	}
}

async function runSnowflake(
	verb: ConnectionVerb,
	connection: Awaited<ReturnType<typeof getConnection>>,
	parsed: ParsedArgs,
	deps: DbDeps,
): Promise<number | void> {
	const client = await deps.sfConnect(connection);
	try {
		if (verb === "query") {
			const sql = await resolveSql(parsed, deps);
			const safety = classifySql(sql, parsed.write);
			if (!safety.allowed) {
				deps.stderr(`BLOCKED: ${safety.reason}`);
				return 1;
			}
			const result = await deps.sfQuery(client, sql);
			deps.stdout(
				result.columns.length === 0 && result.rowsAffected !== undefined
					? formatWriteResult(result.rowsAffected)
					: formatQueryResult(
							result,
							parsed.format ?? "tsv",
							parsed.maxCell ?? 200,
							parsed.limit ?? 50,
						),
			);
			return;
		}
		if (verb === "tables") {
			const schema = parsed.schema || "PUBLIC";
			deps.stdout(formatTables(await deps.sfTables(client, schema), schema));
			return;
		}
		if (verb === "describe") {
			const table = parsed.positional[1];
			if (!table) throw new Error("table name required");
			const info = await deps.sfDescribe(client, table);
			deps.stdout(formatDescribe(table, info.columns, info.rowEstimate));
			return;
		}
		if (verb === "explain") {
			const sql = await resolveSql(parsed, deps);
			const safety = classifySql(sql, parsed.write);
			if (!safety.allowed) {
				deps.stderr(`BLOCKED: ${safety.reason}`);
				return 1;
			}
			deps.stdout(formatExplain(await deps.sfExplain(client, sql)));
			return;
		}
		deps.stdout(
			JSON.stringify(await deps.sfSchema(client, parsed.schema || "PUBLIC")),
		);
	} finally {
		await deps.sfDestroy(client).catch(() => undefined);
	}
}

async function runConnectionVerb(
	verb: ConnectionVerb,
	args: string[],
	deps: DbDeps,
): Promise<number | void> {
	const parsed = parseArgs(args);
	const name = parsed.positional[0];
	if (!name) throw new Error("connection name required");
	const connection = await loadConnection(deps, name);
	return connection.engine === "snowflake"
		? runSnowflake(verb, connection, parsed, deps)
		: runPostgresql(verb, connection, parsed, deps);
}

const description = `Query PostgreSQL and Snowflake databases with read-safe defaults.

Flags: --write, --limit N, --format tsv|json|markdown, --max-cell N, --schema S, -f file.sql`;

export function createDbSpec(overrides: Partial<DbDeps> = {}): CommandSpec {
	const deps = { ...defaultDeps, ...overrides };
	const connected = (verb: ConnectionVerb) => (args: string[]) =>
		safely(deps, () => runConnectionVerb(verb, args, deps));
	return {
		name: "db",
		description,
		subcommands: {
			query: {
				description: "Run a query; use -f file.sql to read SQL from a file.",
				args: ["conn", "SQL"],
				run: connected("query"),
			},
			tables: {
				description: "List tables in a schema.",
				args: ["conn"],
				run: connected("tables"),
			},
			describe: {
				description: "Describe a table's columns.",
				args: ["conn", "table"],
				run: connected("describe"),
			},
			explain: {
				description: "Show a query plan.",
				args: ["conn", "SQL"],
				run: connected("explain"),
			},
			schema: {
				description: "Emit whole-schema tables, columns and foreign keys as JSON.",
				args: ["conn"],
				run: connected("schema"),
			},
			connections: {
				description: "List db/* credential-backed connections.",
				run: () =>
					safely(deps, async () => {
						const client = deps.createCredentialClient();
						try {
							deps.stdout(formatConnections(await listConnections(client)));
						} finally {
							client.close();
						}
					}),
			},
			test: {
				description: "Test connectivity.",
				args: ["conn"],
				run: (args) =>
					safely(deps, async () => {
						const parsed = parseArgs(args);
						const name = parsed.positional[0];
						if (!name) throw new Error("connection name required");
						const connection = await loadConnection(deps, name);
						deps.stdout(
							connection.engine === "snowflake"
								? await deps.sfTest(connection)
								: await deps.pgTest(connection),
						);
					}),
			},
		},
	};
}

export const dbSpec = createDbSpec();
