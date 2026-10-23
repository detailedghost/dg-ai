import * as fs from "node:fs";
import * as path from "node:path";

import { DEFAULT_IGNORE_DIRS } from "./code-graph";
import type { DbColumn, DbEdge, DbNode, EvidenceRecord } from "./graph";

export const DEFAULT_MAX_FILE_SIZE_BYTES = 1_000_000;

const DEFAULT_MIGRATION_GLOBS = ["**/migrations/**/*.sql", "**/db/migrations/**/*.sql"];
const DBT_SOURCES_GLOBS = ["**/models/**/sources.yml", "**/models/**/sources.yaml"];

export interface ParseSqlMigrationsOptions {
	scopePath: string;
	migrationGlobs?: string[];
}

export interface ParseSqlMigrationsResult {
	nodes: DbNode[];
	edges: DbEdge[];
	evidence: EvidenceRecord[];
}

export interface ParseDbtSourcesResult {
	nodes: DbNode[];
	evidence: EvidenceRecord[];
}

function walkFiles(root: string): string[] {
	const results: string[] = [];
	const stack: string[] = [root];
	while (stack.length > 0) {
		const dir = stack.pop() as string;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (DEFAULT_IGNORE_DIRS.includes(entry.name)) continue;
				stack.push(path.join(dir, entry.name));
			} else if (entry.isFile()) {
				results.push(path.join(dir, entry.name));
			}
		}
	}
	return results;
}

/** Only `*`/`**` are supported — enough for the migration/sources globs this module discovers. */
function globToRegExp(glob: string): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				i++;
				if (glob[i + 1] === "/") {
					re += "(?:.*/)?";
					i++;
				} else {
					re += ".*";
				}
			} else {
				re += "[^/]*";
			}
		} else if (c && "/.+^${}()|[]\\".includes(c)) {
			re += c === "/" ? "/" : `\\${c}`;
		} else {
			re += c;
		}
	}
	return new RegExp(`^${re}$`);
}

function discoverByGlobs(scopePath: string, globs: string[]): string[] {
	const patterns = globs.map(globToRegExp);
	const matches = walkFiles(scopePath).filter((abs) => {
		const rel = path.relative(scopePath, abs).split(path.sep).join("/");
		return patterns.some((re) => re.test(rel));
	});
	return matches.sort();
}

interface ParsedForeignKey {
	fromColumn: string;
	toSchema?: string;
	toTable: string;
	toColumn: string;
}

interface ParsedTableStmt {
	schema: string;
	table: string;
	columns: DbColumn[];
	foreignKeys: ParsedForeignKey[];
}

/** Doubled-quote escaping only, matching this parser's SQL/C#/Prisma source quoting; returns the closing quote's index. */
function skipQuotedSpan(content: string, openIndex: number): number {
	const quote = content[openIndex] as string;
	let i = openIndex + 1;
	while (i < content.length) {
		if (content[i] === quote) {
			if (content[i + 1] === quote) {
				i += 2;
				continue;
			}
			return i;
		}
		i++;
	}
	return content.length - 1;
}

/** `openIndex` must point at "("; returns the matching ")" index, or -1 if unbalanced. Parens inside a quoted span (e.g. `DEFAULT 'N/A (unknown)'`) never affect depth. */
function findMatchingParen(content: string, openIndex: number): number {
	let depth = 0;
	for (let i = openIndex; i < content.length; i++) {
		const ch = content[i];
		if (ch === "'" || ch === '"') {
			i = skipQuotedSpan(content, i);
			continue;
		}
		if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/** Same as findMatchingParen, for "{"/"}" — used by Prisma model blocks and EF columns objects. */
function findMatchingBrace(content: string, openIndex: number): number {
	let depth = 0;
	for (let i = openIndex; i < content.length; i++) {
		const ch = content[i];
		if (ch === "'" || ch === '"') {
			i = skipQuotedSpan(content, i);
			continue;
		}
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/** First `;` or newline at/after `fromIndex`, or end of content — used to widen a regex match to its full statement for a NOT NULL check. */
function findStatementEnd(content: string, fromIndex: number): number {
	const semicolon = content.indexOf(";", fromIndex);
	const newline = content.indexOf("\n", fromIndex);
	const candidates = [semicolon, newline].filter((index) => index !== -1);
	return candidates.length > 0 ? Math.min(...candidates) : content.length;
}

/** Splits on top-level commas only, so a nested `NUMERIC(10,2)` or a quoted `DEFAULT 'a, b'` isn't split mid-definition. */
function splitTopLevel(body: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let current = "";
	for (let i = 0; i < body.length; i++) {
		const ch = body[i] as string;
		if (ch === "'" || ch === '"') {
			const end = skipQuotedSpan(body, i);
			current += body.slice(i, end + 1);
			i = end;
			continue;
		}
		if (ch === "(") depth++;
		if (ch === ")") depth--;
		if (ch === "," && depth === 0) {
			parts.push(current);
			current = "";
		} else {
			current += ch;
		}
	}
	if (current.trim().length > 0) parts.push(current);
	return parts;
}

const COLUMN_DEF_RE = /^["`[]?(\w+)["`\]]?\s+([A-Za-z][\w]*(?:\s*\([^)]*\))?)/;
const INLINE_REFERENCES_RE =
	/REFERENCES\s+(?:["`[]?(\w+)["`\]]?\s*\.\s*)?["`[]?(\w+)["`\]]?\s*\(\s*["`[]?(\w+)["`\]]?\s*\)/i;
const TABLE_LEVEL_FK_RE =
	/^(?:CONSTRAINT\s+["`[]?\w+["`\]]?\s+)?FOREIGN\s+KEY\s*\(\s*["`[]?(\w+)["`\]]?\s*\)\s*REFERENCES\s+(?:["`[]?(\w+)["`\]]?\s*\.\s*)?["`[]?(\w+)["`\]]?\s*\(\s*["`[]?(\w+)["`\]]?\s*\)/i;
const TABLE_LEVEL_SKIP_RE = /^(PRIMARY\s+KEY|UNIQUE|CHECK|CONSTRAINT)\b/i;

function parseCreateTableBody(schema: string, table: string, body: string): ParsedTableStmt {
	const columns: DbColumn[] = [];
	const foreignKeys: ParsedForeignKey[] = [];

	for (const rawDef of splitTopLevel(body)) {
		const def = rawDef.trim();
		if (def.length === 0) continue;

		const fkMatch = def.match(TABLE_LEVEL_FK_RE);
		if (fkMatch) {
			foreignKeys.push({
				fromColumn: fkMatch[1] as string,
				...(fkMatch[2] ? { toSchema: fkMatch[2] } : {}),
				toTable: fkMatch[3] as string,
				toColumn: fkMatch[4] as string,
			});
			continue;
		}
		if (TABLE_LEVEL_SKIP_RE.test(def)) continue;

		const colMatch = def.match(COLUMN_DEF_RE);
		if (!colMatch) continue;

		const name = colMatch[1] as string;
		const dataType = (colMatch[2] as string).trim();
		const nullable = !/NOT\s+NULL/i.test(def);
		const isPrimaryKey = /PRIMARY\s+KEY/i.test(def);
		const inlineRef = def.match(INLINE_REFERENCES_RE);

		columns.push({
			name,
			dataType,
			nullable,
			...(isPrimaryKey ? { isPrimaryKey: true } : {}),
			...(inlineRef ? { isForeignKey: true } : {}),
		});

		if (inlineRef) {
			foreignKeys.push({
				fromColumn: name,
				...(inlineRef[1] ? { toSchema: inlineRef[1] } : {}),
				toTable: inlineRef[2] as string,
				toColumn: inlineRef[3] as string,
			});
		}
	}

	if (columns.length === 0 && foreignKeys.length === 0) {
		throw new Error(`CREATE TABLE ${table}: no parseable column or constraint definitions found`);
	}

	return { schema, table, columns, foreignKeys };
}

const CREATE_TABLE_RE =
	/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:["`[]?(\w+)["`\]]?\s*\.\s*)?["`[]?(\w+)["`\]]?\s*\(/gi;
const CREATE_TABLE_LOOSE_RE = /CREATE\s+TABLE\b/gi;
const ALTER_ADD_COLUMN_RE =
	/ALTER\s+TABLE\s+["`[]?(\w+)["`\]]?\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?(\w+)["`\]]?\s+([A-Za-z][\w]*(?:\s*\([^)]*\))?)/gi;
const ALTER_TABLE_LOOSE_RE = /ALTER\s+TABLE\s+["`[]?\w+["`\]]?\s+ADD\s+COLUMN\b/gi;

interface ParsedFile {
	creates: ParsedTableStmt[];
	alters: Array<{ table: string; column: DbColumn }>;
}

/** Throws on structurally-recognizable-but-unparseable SQL, for a file-level evidence note instead of aborting the run. */
function parseSqlFileContent(content: string): ParsedFile {
	const creates: ParsedTableStmt[] = [];
	const alters: Array<{ table: string; column: DbColumn }> = [];

	let strictCreateCount = 0;
	CREATE_TABLE_RE.lastIndex = 0;
	for (let m = CREATE_TABLE_RE.exec(content); m; m = CREATE_TABLE_RE.exec(content)) {
		strictCreateCount++;
		const schema = (m[1] as string | undefined) ?? "public";
		const table = m[2] as string;
		const openIndex = m.index + m[0].length - 1;
		const closeIndex = findMatchingParen(content, openIndex);
		if (closeIndex === -1) {
			throw new Error(`CREATE TABLE ${table}: unbalanced parentheses`);
		}
		const body = content.slice(openIndex + 1, closeIndex);
		creates.push(parseCreateTableBody(schema, table, body));
		CREATE_TABLE_RE.lastIndex = closeIndex + 1;
	}

	CREATE_TABLE_LOOSE_RE.lastIndex = 0;
	const looseCreateCount = content.match(CREATE_TABLE_LOOSE_RE)?.length ?? 0;
	if (looseCreateCount > 0 && strictCreateCount < looseCreateCount) {
		throw new Error("CREATE TABLE statement found but could not be parsed");
	}

	let strictAlterCount = 0;
	ALTER_ADD_COLUMN_RE.lastIndex = 0;
	for (let m = ALTER_ADD_COLUMN_RE.exec(content); m; m = ALTER_ADD_COLUMN_RE.exec(content)) {
		strictAlterCount++;
		const def = content.slice(m.index, findStatementEnd(content, m.index + m[0].length));
		alters.push({
			table: m[1] as string,
			column: {
				name: m[2] as string,
				dataType: (m[3] as string).trim(),
				nullable: !/NOT\s+NULL/i.test(def),
			},
		});
	}

	ALTER_TABLE_LOOSE_RE.lastIndex = 0;
	const looseAlterCount = content.match(ALTER_TABLE_LOOSE_RE)?.length ?? 0;
	if (looseAlterCount > 0 && strictAlterCount < looseAlterCount) {
		throw new Error("ALTER TABLE ADD COLUMN statement found but could not be parsed");
	}

	return { creates, alters };
}

interface TableEntry {
	schema: string;
	table: string;
	columns: Map<string, DbColumn>;
}

/** Node/edge ids are "<schema>.<table>"; CREATE TABLE honors a captured schema qualifier, defaulting to "public" when unqualified. ALTER TABLE ADD COLUMN's regex captures no schema, so it always targets "public". */
export function parseSqlMigrations(opts: ParseSqlMigrationsOptions): ParseSqlMigrationsResult {
	const globs = opts.migrationGlobs ?? DEFAULT_MIGRATION_GLOBS;
	const files = discoverByGlobs(opts.scopePath, globs);

	const tables = new Map<string, TableEntry>();
	const pendingFks: Array<{ fromSchema: string; fromTable: string; fk: ParsedForeignKey }> = [];
	const evidence: EvidenceRecord[] = [];

	function ensureTable(schema: string, table: string): Map<string, DbColumn> {
		const key = `${schema}.${table}`;
		let entry = tables.get(key);
		if (!entry) {
			entry = { schema, table, columns: new Map() };
			tables.set(key, entry);
		}
		return entry.columns;
	}

	for (const file of files) {
		let stat: fs.Stats;
		try {
			stat = fs.statSync(file);
		} catch {
			continue;
		}
		if (stat.size > DEFAULT_MAX_FILE_SIZE_BYTES) {
			evidence.push({
				type: "file",
				ref: file,
				detail: `skipped: exceeds max file size (${DEFAULT_MAX_FILE_SIZE_BYTES} bytes)`,
			});
			continue;
		}

		let content: string;
		try {
			content = fs.readFileSync(file, "utf8");
		} catch (err) {
			evidence.push({ type: "file", ref: file, detail: `skipped: could not read file (${(err as Error).message})` });
			continue;
		}

		let parsed: ParsedFile;
		try {
			parsed = parseSqlFileContent(content);
		} catch (err) {
			evidence.push({ type: "file", ref: file, detail: `skipped: ${(err as Error).message}` });
			continue;
		}

		for (const stmt of parsed.creates) {
			const cols = ensureTable(stmt.schema, stmt.table);
			for (const col of stmt.columns) cols.set(col.name, col);
			for (const fk of stmt.foreignKeys) {
				pendingFks.push({ fromSchema: stmt.schema, fromTable: stmt.table, fk });
			}
		}
		for (const alter of parsed.alters) {
			const cols = ensureTable("public", alter.table);
			cols.set(alter.column.name, alter.column);
		}
	}

	const edges: DbEdge[] = pendingFks.map(({ fromSchema, fromTable, fk }) => {
		const toSchema = fk.toSchema ?? (tables.has(`${fromSchema}.${fk.toTable}`) ? fromSchema : "public");
		return {
			from: `${fromSchema}.${fromTable}`,
			to: `${toSchema}.${fk.toTable}`,
			fromColumn: fk.fromColumn,
			toColumn: fk.toColumn,
			confidence: "proven",
		};
	});

	const nodes: DbNode[] = Array.from(tables.entries()).map(([key, entry]) => ({
		id: key,
		label: entry.table,
		schema: entry.schema,
		columns: Array.from(entry.columns.values()),
		source: "static-sql",
	}));

	return { nodes, edges, evidence };
}

const DBT_NAME_ENTRY_RE = /^-\s*name:\s*["']?([^"'\s]+)["']?\s*$/;

function extractDbtTables(content: string): { sourceName: string | undefined; tables: string[] }[] {
	const lines = content.split(/\r?\n/);
	const groups: { sourceName: string | undefined; tables: string[] }[] = [];

	let currentSourceIndent = -1;
	let inTables = false;
	let tablesIndent = -1;
	let inColumns = false;
	let columnsIndent = -1;

	for (const line of lines) {
		if (line.trim().length === 0) continue;
		const indent = line.length - line.trimStart().length;
		const trimmed = line.trim();

		if (inColumns && indent <= columnsIndent) inColumns = false;
		if (inTables && indent <= tablesIndent) inTables = false;

		const sourceMatch = trimmed.match(DBT_NAME_ENTRY_RE);
		if (sourceMatch && !inTables) {
			currentSourceIndent = indent;
			groups.push({ sourceName: sourceMatch[1], tables: [] });
			continue;
		}

		if (/^tables:\s*$/.test(trimmed) && indent > currentSourceIndent) {
			inTables = true;
			tablesIndent = indent;
			continue;
		}

		if (!inTables) continue;

		if (/^columns:\s*$/.test(trimmed)) {
			inColumns = true;
			columnsIndent = indent;
			continue;
		}

		if (inColumns) continue;

		const tableMatch = trimmed.match(DBT_NAME_ENTRY_RE);
		const currentGroup = groups.at(-1);
		if (tableMatch && currentGroup) currentGroup.tables.push(tableMatch[1] as string);
	}

	return groups;
}

/** DbNode ids are "<schema>.<table>"; dbt's source name becomes the schema. */
export function parseDbtSources(scopePath: string): ParseDbtSourcesResult {
	const files = discoverByGlobs(scopePath, DBT_SOURCES_GLOBS);
	const nodes: DbNode[] = [];
	const evidence: EvidenceRecord[] = [];

	for (const file of files) {
		let stat: fs.Stats;
		try {
			stat = fs.statSync(file);
		} catch {
			continue;
		}
		if (stat.size > DEFAULT_MAX_FILE_SIZE_BYTES) {
			evidence.push({
				type: "file",
				ref: file,
				detail: `skipped: exceeds max file size (${DEFAULT_MAX_FILE_SIZE_BYTES} bytes)`,
			});
			continue;
		}

		let content: string;
		try {
			content = fs.readFileSync(file, "utf8");
		} catch (err) {
			evidence.push({ type: "file", ref: file, detail: `skipped: could not read file (${(err as Error).message})` });
			continue;
		}

		let groups: { sourceName: string | undefined; tables: string[] }[];
		try {
			groups = extractDbtTables(content);
		} catch (err) {
			evidence.push({ type: "file", ref: file, detail: `skipped: ${(err as Error).message}` });
			continue;
		}

		for (const group of groups) {
			const schema = group.sourceName ?? "";
			for (const table of group.tables) {
				nodes.push({
					id: `${schema}.${table}`,
					label: table,
					schema,
					columns: [],
					source: "static-dbt",
				});
			}
		}
	}

	return { nodes, evidence };
}

export type StaticOrmResult = ParseSqlMigrationsResult;

interface PrismaField {
	name: string;
	type: string;
	attrsRaw: string;
	optional: boolean;
}

interface PrismaModel {
	name: string;
	mappedName?: string;
	fields: PrismaField[];
}

const PRISMA_FIELD_RE = /^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/;
const PRISMA_MAP_RE = /^@@map\(\s*"([^"]+)"\s*\)/;

/** Throws when a `model` block's braces never balance, for a file-level evidence note instead of aborting. */
function parsePrismaFileContent(content: string): { models: PrismaModel[] } {
	const models: PrismaModel[] = [];
	const looseCount = content.match(/model\s+\w+\s*\{/g)?.length ?? 0;
	let strictCount = 0;

	const modelRe = /model\s+(\w+)\s*\{/g;
	for (let m = modelRe.exec(content); m; m = modelRe.exec(content)) {
		const name = m[1] as string;
		const openIndex = m.index + m[0].length - 1;
		const closeIndex = findMatchingBrace(content, openIndex);
		if (closeIndex === -1) continue;
		strictCount++;

		const body = content.slice(openIndex + 1, closeIndex);
		const fields: PrismaField[] = [];
		let mappedName: string | undefined;

		for (const rawLine of body.split(/\r?\n/)) {
			const line = rawLine.trim();
			if (line.length === 0 || line.startsWith("//")) continue;
			if (line.startsWith("@@")) {
				const mapMatch = line.match(PRISMA_MAP_RE);
				if (mapMatch) mappedName = mapMatch[1] as string;
				continue;
			}
			const fieldMatch = line.match(PRISMA_FIELD_RE);
			if (!fieldMatch) continue;
			fields.push({
				name: fieldMatch[1] as string,
				type: fieldMatch[2] as string,
				optional: Boolean(fieldMatch[4]),
				attrsRaw: (fieldMatch[5] as string) ?? "",
			});
		}

		models.push({ name, mappedName, fields });
		modelRe.lastIndex = closeIndex + 1;
	}

	if (strictCount < looseCount) {
		throw new Error("model block found but could not be parsed (unbalanced braces)");
	}

	return { models };
}

const PRISMA_RELATION_RE = /@relation\(\s*fields:\s*\[([^\]]+)\]\s*,\s*references:\s*\[([^\]]+)\]/;

/** Relation-object fields drive edges only; a plain field whose type is another model is excluded from columns. */
function buildPrismaNodesAndEdges(models: PrismaModel[]): { nodes: DbNode[]; edges: DbEdge[] } {
	const modelNames = new Set(models.map((m) => m.name));
	const labelOf = new Map(models.map((m) => [m.name, m.mappedName ?? m.name]));

	const nodes: DbNode[] = [];
	const edges: DbEdge[] = [];

	for (const model of models) {
		const label = labelOf.get(model.name) as string;
		const fkColumns = new Set<string>();

		for (const field of model.fields) {
			if (!modelNames.has(field.type)) continue;
			const relationMatch = field.attrsRaw.match(PRISMA_RELATION_RE);
			if (!relationMatch) continue;
			const fromColumn = (relationMatch[1] as string).split(",")[0]?.trim() ?? "";
			const toColumn = (relationMatch[2] as string).split(",")[0]?.trim() ?? "";
			const toLabel = labelOf.get(field.type) ?? field.type;
			fkColumns.add(fromColumn);
			edges.push({ from: `public.${label}`, to: `public.${toLabel}`, fromColumn, toColumn, confidence: "proven" });
		}

		const columns: DbColumn[] = [];
		for (const field of model.fields) {
			if (modelNames.has(field.type)) continue;
			columns.push({
				name: field.name,
				dataType: field.type,
				nullable: field.optional,
				...(/@id\b/.test(field.attrsRaw) ? { isPrimaryKey: true } : {}),
				...(fkColumns.has(field.name) ? { isForeignKey: true } : {}),
			});
		}

		nodes.push({ id: `public.${label}`, label, schema: "public", columns, source: "static-prisma" });
	}

	return { nodes, edges };
}

export function parsePrismaSchema(schemaFilePath: string): StaticOrmResult {
	const evidence: EvidenceRecord[] = [];

	let stat: fs.Stats;
	try {
		stat = fs.statSync(schemaFilePath);
	} catch (err) {
		evidence.push({
			type: "file",
			ref: schemaFilePath,
			detail: `skipped: could not stat file (${(err as Error).message})`,
		});
		return { nodes: [], edges: [], evidence };
	}
	if (stat.size > DEFAULT_MAX_FILE_SIZE_BYTES) {
		evidence.push({
			type: "file",
			ref: schemaFilePath,
			detail: `skipped: exceeds max file size (${DEFAULT_MAX_FILE_SIZE_BYTES} bytes)`,
		});
		return { nodes: [], edges: [], evidence };
	}

	let content: string;
	try {
		content = fs.readFileSync(schemaFilePath, "utf8");
	} catch (err) {
		evidence.push({
			type: "file",
			ref: schemaFilePath,
			detail: `skipped: could not read file (${(err as Error).message})`,
		});
		return { nodes: [], edges: [], evidence };
	}

	let parsed: { models: PrismaModel[] };
	try {
		parsed = parsePrismaFileContent(content);
	} catch (err) {
		evidence.push({ type: "file", ref: schemaFilePath, detail: `skipped: ${(err as Error).message}` });
		return { nodes: [], edges: [], evidence };
	}

	const { nodes, edges } = buildPrismaNodesAndEdges(parsed.models);
	return { nodes, edges, evidence };
}

interface ParsedCsTable {
	table: string;
	columns: DbColumn[];
	foreignKeys: ParsedForeignKey[];
}

interface ParsedCsAddColumn {
	table: string;
	column: DbColumn;
}

/** Named `.ForeignKey(...)` arguments only, per real EF Core codegen output — never positional. */
function parseCsCreateTableCalls(content: string): ParsedCsTable[] {
	const tables: ParsedCsTable[] = [];
	const createTableRe = /migrationBuilder\.CreateTable\s*\(/g;

	for (let m = createTableRe.exec(content); m; m = createTableRe.exec(content)) {
		const openParenIndex = m.index + m[0].length - 1;
		const closeParenIndex = findMatchingParen(content, openParenIndex);
		if (closeParenIndex === -1) {
			throw new Error("migrationBuilder.CreateTable(...) call has unbalanced parentheses");
		}
		const callBody = content.slice(openParenIndex + 1, closeParenIndex);
		createTableRe.lastIndex = closeParenIndex + 1;

		const nameMatch = callBody.match(/name:\s*"([^"]+)"/);
		if (!nameMatch) {
			throw new Error("migrationBuilder.CreateTable(...) call is missing a name: argument");
		}
		const table = nameMatch[1] as string;

		const columns: DbColumn[] = [];
		const columnsBlockMatch = callBody.match(/columns:\s*table\s*=>\s*new\s*\{/);
		if (columnsBlockMatch) {
			const braceOpen = (columnsBlockMatch.index as number) + columnsBlockMatch[0].length - 1;
			const braceClose = findMatchingBrace(callBody, braceOpen);
			if (braceClose === -1) {
				throw new Error(`migrationBuilder.CreateTable(${table}, ...) columns block has unbalanced braces`);
			}
			const columnsBody = callBody.slice(braceOpen + 1, braceClose);
			const colRe = /(\w+)\s*=\s*table\.Column<([^>]+)>\(([^)]*)\)/g;
			for (let cm = colRe.exec(columnsBody); cm; cm = colRe.exec(columnsBody)) {
				const nullableMatch = (cm[3] as string).match(/nullable:\s*(true|false)/);
				columns.push({
					name: cm[1] as string,
					dataType: cm[2] as string,
					nullable: nullableMatch ? nullableMatch[1] === "true" : false,
				});
			}
		}

		const foreignKeys: ParsedForeignKey[] = [];
		const fkCallRe = /table\.ForeignKey\s*\(/g;
		for (let fm = fkCallRe.exec(callBody); fm; fm = fkCallRe.exec(callBody)) {
			const fkOpen = fm.index + fm[0].length - 1;
			const fkClose = findMatchingParen(callBody, fkOpen);
			if (fkClose === -1) continue;
			const fkBody = callBody.slice(fkOpen + 1, fkClose);
			const columnMatch = fkBody.match(/column:\s*x\s*=>\s*x\.(\w+)/);
			const principalTableMatch = fkBody.match(/principalTable:\s*"([^"]+)"/);
			const principalColumnMatch = fkBody.match(/principalColumn:\s*"([^"]+)"/);
			if (columnMatch && principalTableMatch && principalColumnMatch) {
				foreignKeys.push({
					fromColumn: columnMatch[1] as string,
					toTable: principalTableMatch[1] as string,
					toColumn: principalColumnMatch[1] as string,
				});
			}
			fkCallRe.lastIndex = fkClose + 1;
		}

		tables.push({ table, columns, foreignKeys });
	}

	return tables;
}

/** EF equivalent of a SQL `ALTER TABLE ADD COLUMN`, for later migrations touching an existing table. */
function parseCsAddColumnCalls(content: string): ParsedCsAddColumn[] {
	const results: ParsedCsAddColumn[] = [];
	const addColumnRe = /migrationBuilder\.AddColumn<([^>]+)>\s*\(/g;

	for (let m = addColumnRe.exec(content); m; m = addColumnRe.exec(content)) {
		const csharpType = m[1] as string;
		const openIndex = m.index + m[0].length - 1;
		const closeIndex = findMatchingParen(content, openIndex);
		if (closeIndex === -1) {
			throw new Error("migrationBuilder.AddColumn<...>(...) call has unbalanced parentheses");
		}
		addColumnRe.lastIndex = closeIndex + 1;

		const body = content.slice(openIndex + 1, closeIndex);
		const nameMatch = body.match(/name:\s*"([^"]+)"/);
		const tableMatch = body.match(/table:\s*"([^"]+)"/);
		if (!nameMatch || !tableMatch) continue;
		const typeMatch = body.match(/type:\s*"([^"]+)"/);
		const nullableMatch = body.match(/nullable:\s*(true|false)/);

		results.push({
			table: tableMatch[1] as string,
			column: {
				name: nameMatch[1] as string,
				dataType: (typeMatch ? typeMatch[1] : csharpType) as string,
				nullable: nullableMatch ? nullableMatch[1] === "true" : true,
			},
		});
	}

	return results;
}

export function parseEfMigrations(migrationsDir: string): StaticOrmResult {
	const evidence: EvidenceRecord[] = [];
	const files = walkFiles(migrationsDir)
		.filter((f) => f.endsWith(".cs"))
		.sort();

	const nodeColumns = new Map<string, Map<string, DbColumn>>();
	const edges: DbEdge[] = [];

	function ensureTable(table: string): Map<string, DbColumn> {
		let cols = nodeColumns.get(table);
		if (!cols) {
			cols = new Map();
			nodeColumns.set(table, cols);
		}
		return cols;
	}

	for (const file of files) {
		let stat: fs.Stats;
		try {
			stat = fs.statSync(file);
		} catch {
			continue;
		}
		if (stat.size > DEFAULT_MAX_FILE_SIZE_BYTES) {
			evidence.push({
				type: "file",
				ref: file,
				detail: `skipped: exceeds max file size (${DEFAULT_MAX_FILE_SIZE_BYTES} bytes)`,
			});
			continue;
		}

		let content: string;
		try {
			content = fs.readFileSync(file, "utf8");
		} catch (err) {
			evidence.push({ type: "file", ref: file, detail: `skipped: could not read file (${(err as Error).message})` });
			continue;
		}

		let tables: ParsedCsTable[];
		let addColumns: ParsedCsAddColumn[];
		try {
			tables = parseCsCreateTableCalls(content);
			addColumns = parseCsAddColumnCalls(content);
		} catch (err) {
			evidence.push({ type: "file", ref: file, detail: `skipped: ${(err as Error).message}` });
			continue;
		}

		for (const t of tables) {
			const cols = ensureTable(t.table);
			for (const col of t.columns) cols.set(col.name, col);
			for (const fk of t.foreignKeys) {
				edges.push({
					from: `dbo.${t.table}`,
					to: `dbo.${fk.toTable}`,
					fromColumn: fk.fromColumn,
					toColumn: fk.toColumn,
					confidence: "proven",
				});
			}
		}
		for (const ac of addColumns) {
			ensureTable(ac.table).set(ac.column.name, ac.column);
		}
	}

	const nodes: DbNode[] = Array.from(nodeColumns.entries()).map(([table, cols]) => ({
		id: `dbo.${table}`,
		label: table,
		schema: "dbo",
		columns: Array.from(cols.values()),
		source: "static-ef",
	}));

	return { nodes, edges, evidence };
}

const EF_MIGRATION_GLOBS = ["**/Migrations/**/*.cs"];

function findMigrationsRoot(csFilePath: string): string | undefined {
	const parts = csFilePath.split(path.sep);
	const idx = parts.lastIndexOf("Migrations");
	if (idx === -1) return undefined;
	return parts.slice(0, idx + 1).join(path.sep);
}

/** First non-empty result wins, not first present format — a malformed/oversized Prisma schema falls through to EF/SQL/dbt. */
export function collectStaticSchema(scopePath: string): StaticOrmResult {
	const prismaFiles = discoverByGlobs(scopePath, ["**/schema.prisma"]);
	const efFiles = discoverByGlobs(scopePath, EF_MIGRATION_GLOBS);
	const sqlFiles = discoverByGlobs(scopePath, DEFAULT_MIGRATION_GLOBS);
	const dbtFiles = discoverByGlobs(scopePath, DBT_SOURCES_GLOBS);

	const prismaPath = prismaFiles[0];
	const efDir = efFiles[0] ? findMigrationsRoot(efFiles[0]) : undefined;
	const sqlPresent = sqlFiles.length > 0;
	const dbtPresent = dbtFiles.length > 0;

	const foundLabels: string[] = [];
	if (prismaPath) foundLabels.push(path.relative(scopePath, prismaPath));
	if (efDir) foundLabels.push(`${path.relative(scopePath, efDir)} (EF Core migrations)`);
	if (sqlPresent) foundLabels.push("SQL migrations");
	if (dbtPresent) foundLabels.push("dbt sources.yml");

	const candidates: { label: string; parse: () => StaticOrmResult }[] = [];
	if (prismaPath)
		candidates.push({ label: path.relative(scopePath, prismaPath), parse: () => parsePrismaSchema(prismaPath) });
	if (efDir) {
		candidates.push({
			label: `${path.relative(scopePath, efDir)} (EF Core migrations)`,
			parse: () => parseEfMigrations(efDir),
		});
	}
	if (sqlPresent) candidates.push({ label: "SQL migrations", parse: () => parseSqlMigrations({ scopePath }) });
	if (dbtPresent) {
		candidates.push({
			label: "dbt sources.yml",
			parse: () => {
				const dbtResult = parseDbtSources(scopePath);
				return { nodes: dbtResult.nodes, edges: [], evidence: dbtResult.evidence };
			},
		});
	}

	const collectedEvidence: EvidenceRecord[] = [];
	let result: StaticOrmResult | undefined;
	let usedLabel: string | undefined;
	let lastAttempted: { result: StaticOrmResult; label: string } | undefined;

	for (const candidate of candidates) {
		const attempt = candidate.parse();
		collectedEvidence.push(...attempt.evidence);
		lastAttempted = { result: attempt, label: candidate.label };
		if (attempt.nodes.length > 0) {
			result = attempt;
			usedLabel = candidate.label;
			break;
		}
	}

	if (!result && lastAttempted) {
		result = lastAttempted.result;
		usedLabel = lastAttempted.label;
	}

	if (!result) return { nodes: [], edges: [], evidence: [] };

	const evidence = [...collectedEvidence];
	if (foundLabels.length > 1 && usedLabel) {
		const others = foundLabels.filter((label) => label !== usedLabel);
		evidence.push({
			type: "file",
			ref: scopePath,
			detail: `Static schema parsed from: ${usedLabel} (${others.join(", ")} also present but not used — see limitations)`,
		});
	}

	return { nodes: result.nodes, edges: result.edges, evidence };
}
