import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
	applyConnectionPragmas,
	type DgPaths,
	ensurePrivateDir,
	readSchemaVersion,
	runMigrations,
} from "@dg/common/node";
import { MEMORY_SCHEMA_STEPS } from "./schema";

export const MEMORY_PAGE_SIZE = 20;
export const MEMORY_MAX_PAGE_SIZE = 100;
export const MEMORY_DEFAULT_KIND = "note";

const TITLE_WEIGHT = 10.0;
const BODY_WEIGHT = 1.0;
const FTS_TOKEN = /[\p{L}\p{N}_]+/gu;

export type MemoryRecord = {
	id: string;
	agentIdentity: string;
	workset?: string;
	kind: string;
	title: string;
	body: string;
	createdAt: string;
	updatedAt: string;
};

export type WriteMemoryInput = {
	agentIdentity: string;
	title: string;
	body: string;
	kind?: string;
	workset?: string;
};

export type SearchMemoryInput = {
	query?: string;
	agentIdentity?: string;
	workset?: string;
	limit?: number;
	offset?: number;
};

export type MemorySeams = { now?: () => Date };

type MemoryBindings = Record<string, string | number>;

type MemoryRow = {
	id: string;
	agent_identity: string;
	workset: string | null;
	kind: string;
	title: string;
	body: string;
	created_at: string;
	updated_at: string;
};

const RECORD_COLUMNS =
	"id, agent_identity, workset, kind, title, body, created_at, updated_at";

const JOINED_RECORD_COLUMNS = RECORD_COLUMNS.split(", ")
	.map((column) => `m.${column}`)
	.join(", ");

const UPSERT_SQL = `INSERT INTO memories (${RECORD_COLUMNS})
VALUES ($id, $identity, $workset, $kind, $title, $body, $now, $now)
ON CONFLICT (agent_identity, ifnull(workset, ''), title) DO UPDATE SET
	kind = excluded.kind,
	body = excluded.body,
	updated_at = excluded.updated_at
RETURNING ${RECORD_COLUMNS}`;

/** Turns free text into an FTS5 MATCH expression, so no query can be a syntax error. */
export function toMatchExpression(query: string): string | undefined {
	const tokens = query.match(FTS_TOKEN);
	return tokens ? tokens.map((token) => `"${token}"`).join(" AND ") : undefined;
}

function toRecord(row: MemoryRow): MemoryRecord {
	return {
		id: row.id,
		agentIdentity: row.agent_identity,
		workset: row.workset ?? undefined,
		kind: row.kind,
		title: row.title,
		body: row.body,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function boundedLimit(limit: number | undefined): number {
	if (limit === undefined) return MEMORY_PAGE_SIZE;
	return Math.max(1, Math.min(MEMORY_MAX_PAGE_SIZE, Math.trunc(limit)));
}

export function scopeClauses(input: SearchMemoryInput, table: string): string {
	const clauses: string[] = [];
	if (input.agentIdentity !== undefined) {
		clauses.push(`${table}.agent_identity = $identity`);
	}
	if (input.workset !== undefined) clauses.push(`${table}.workset = $workset`);
	return clauses.join(" AND ");
}

function scopeBindings(input: SearchMemoryInput): MemoryBindings {
	const bindings: MemoryBindings = {
		limit: boundedLimit(input.limit),
		offset: Math.max(0, Math.trunc(input.offset ?? 0)),
	};
	if (input.agentIdentity !== undefined)
		bindings.identity = input.agentIdentity;
	if (input.workset !== undefined) bindings.workset = input.workset;
	return bindings;
}

export function recentQuery(scope: string): string {
	return `SELECT ${RECORD_COLUMNS} FROM memories
		${scope ? `WHERE ${scope}` : ""}
		ORDER BY updated_at DESC
		LIMIT $limit OFFSET $offset`;
}

export function rankedQuery(scope: string): string {
	return `SELECT ${JOINED_RECORD_COLUMNS}
		FROM memories_fts
		JOIN memories m ON m.rowid = memories_fts.rowid
		WHERE memories_fts MATCH $match ${scope ? `AND ${scope}` : ""}
		ORDER BY bm25(memories_fts, ${TITLE_WEIGHT}, ${BODY_WEIGHT})
		LIMIT $limit OFFSET $offset`;
}

export const READ_QUERY = `SELECT ${RECORD_COLUMNS} FROM memories WHERE id = $id`;

export class MemoryStore {
	private constructor(
		private readonly db: Database,
		private readonly now: () => Date,
	) {}

	static open(paths: DgPaths, seams: MemorySeams = {}): MemoryStore {
		ensurePrivateDir(paths.agentsDir);
		const db = new Database(paths.memoryDbPath, {
			strict: true,
			create: true,
			readwrite: true,
		});
		try {
			applyConnectionPragmas(db);
			const migrated = readSchemaVersion(db) > 0;
			runMigrations(
				db,
				MEMORY_SCHEMA_STEPS,
				migrated ? { snapshotDir: paths.agentsDir } : {},
			);
		} catch (err) {
			db.close(true);
			throw err;
		}
		return new MemoryStore(db, seams.now ?? (() => new Date()));
	}

	write(input: WriteMemoryInput): MemoryRecord {
		const row = this.db.query(UPSERT_SQL).get({
			id: randomUUID(),
			identity: input.agentIdentity,
			workset: input.workset ?? null,
			kind: input.kind ?? MEMORY_DEFAULT_KIND,
			title: input.title,
			body: input.body,
			now: this.now().toISOString(),
		}) as MemoryRow;
		return toRecord(row);
	}

	search(input: SearchMemoryInput = {}): MemoryRecord[] {
		const bindings = scopeBindings(input);
		if (input.query === undefined || input.query.trim() === "") {
			return this.#recent(input, bindings);
		}
		const match = toMatchExpression(input.query);
		if (!match) return [];
		return this.#ranked(input, { ...bindings, match });
	}

	read(id: string): MemoryRecord | undefined {
		const row = this.db.query(READ_QUERY).get({ id }) as MemoryRow | null;
		return row ? toRecord(row) : undefined;
	}

	forget(id: string): boolean {
		return (
			(
				this.db
					.query("DELETE FROM memories WHERE id = $id RETURNING id")
					.all({ id }) as { id: string }[]
			).length > 0
		);
	}

	close(): void {
		this.db.close(true);
	}

	#recent(input: SearchMemoryInput, bindings: MemoryBindings): MemoryRecord[] {
		const rows = this.db
			.query(recentQuery(scopeClauses(input, "memories")))
			.all(bindings) as MemoryRow[];
		return rows.map(toRecord);
	}

	#ranked(input: SearchMemoryInput, bindings: MemoryBindings): MemoryRecord[] {
		const rows = this.db
			.query(rankedQuery(scopeClauses(input, "m")))
			.all(bindings) as MemoryRow[];
		return rows.map(toRecord);
	}
}
