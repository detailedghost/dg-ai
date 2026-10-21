const MAX_OUTPUT_BYTES = 64 * 1024;
const TRUNCATION_NOTICE = "TRUNCATED: output exceeded 64KB limit (use --limit)\n";

const CREDENTIAL_PATTERNS = [
	/(?:password|token|passphrase|privateKeyPass)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
	/-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g,
	/postgresql:\/\/[^@\s]*@/gi,
	/snowflake:\/\/[^@\s]*@/gi,
];

export type OutputFormat = "tsv" | "json" | "markdown";

export interface QueryResult {
	columns: string[];
	rows: unknown[][];
	totalRows: number;
	rowsAffected?: number;
}

export function sanitizeError(msg: string): string {
	let cleaned = msg;
	for (const pattern of CREDENTIAL_PATTERNS)
		cleaned = cleaned.replace(pattern, "[REDACTED]");
	return cleaned;
}

function truncateCell(value: unknown, maxCell: number): string {
	const string = value === null || value === undefined ? "" : String(value);
	if (string.length <= maxCell) return string;
	return `${string.slice(0, maxCell)}...`;
}

function enforceByteLimit(output: string): string {
	if (Buffer.byteLength(output, "utf8") <= MAX_OUTPUT_BYTES) return output;
	const bodyLimit = MAX_OUTPUT_BYTES - Buffer.byteLength(TRUNCATION_NOTICE, "utf8");
	let truncated = Buffer.from(output, "utf8").subarray(0, bodyLimit).toString("utf8");
	while (Buffer.byteLength(truncated, "utf8") > bodyLimit)
		truncated = truncated.slice(0, -1);
	const lastNewline = truncated.lastIndexOf("\n");
	if (lastNewline > 0) truncated = truncated.slice(0, lastNewline);
	return `${TRUNCATION_NOTICE}${truncated}`;
}

function formatTsv(columns: string[], rows: unknown[][], maxCell: number): string {
	return [
		columns.join("\t"),
		...rows.map((row) => row.map((value) => truncateCell(value, maxCell)).join("\t")),
	].join("\n");
}

function formatJson(columns: string[], rows: unknown[][], maxCell: number): string {
	return rows
		.map((row) => {
			const object: Record<string, string> = {};
			for (let i = 0; i < columns.length; i++)
				object[columns[i] ?? ""] = truncateCell(row[i], maxCell);
			return JSON.stringify(object);
		})
		.join("\n");
}

function formatMarkdown(
	columns: string[],
	rows: unknown[][],
	maxCell: number,
): string {
	return [
		`| ${columns.join(" | ")} |`,
		`| ${columns.map(() => "---").join(" | ")} |`,
		...rows.map(
			(row) =>
				`| ${row.map((value) => truncateCell(value, maxCell)).join(" | ")} |`,
		),
	].join("\n");
}

export function formatQueryResult(
	result: QueryResult,
	format: OutputFormat,
	maxCell: number,
	limit: number,
): string {
	const rows = result.rows.slice(0, limit);
	const header = `ROWS: ${rows.length}/${result.totalRows}`;
	if (result.columns.length === 0) return `${header}\n(no columns)`;
	const body =
		format === "json"
			? formatJson(result.columns, rows, maxCell)
			: format === "markdown"
				? formatMarkdown(result.columns, rows, maxCell)
				: formatTsv(result.columns, rows, maxCell);
	return enforceByteLimit(`${header}\n${body}`);
}

export function formatWriteResult(rowsAffected: number): string {
	return `OK: ${rowsAffected} rows affected`;
}

export function formatError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return `ERROR: ${sanitizeError(message)}`;
}

export function formatTables(tables: string[], schema: string): string {
	return `TABLES: ${tables.length} (schema: ${schema})\n${tables.join("\n")}`;
}

export function formatDescribe(
	tableName: string,
	columns: Array<{
		name: string;
		type: string;
		nullable: string;
		defaultVal: string;
	}>,
	rowEstimate?: number,
): string {
	const count = rowEstimate === undefined ? "" : `, ~${rowEstimate} rows`;
	return [
		`TABLE: ${tableName} (${columns.length} cols${count})`,
		"name\ttype\tnullable\tdefault",
		...columns.map(
			(column) =>
				`${column.name}\t${column.type}\t${column.nullable}\t${column.defaultVal}`,
		),
	].join("\n");
}

export function formatExplain(plan: string): string {
	return `PLAN:\n${plan}`;
}

export function formatConnections(
	connections: Array<{ name: string; engine: string; target: string }>,
): string {
	if (connections.length === 0) return "CONNECTIONS: 0\n(none configured)";
	return [
		`CONNECTIONS: ${connections.length}`,
		"name\tengine\ttarget",
		...connections.map(
			(connection) =>
				`${connection.name}\t${connection.engine}\t${connection.target}`,
		),
	].join("\n");
}
