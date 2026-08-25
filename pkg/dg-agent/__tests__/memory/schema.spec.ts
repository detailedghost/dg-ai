import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type DgPaths,
	ForwardOnlyVersionError,
	readSchemaVersion,
	resolveDgPaths,
} from "@dg/common/node";
import { cleanupDgHome, freshDgHome } from "@dg/dg-daemon/test-harness";
import { CURRENT_MEMORY_SCHEMA_VERSION } from "../../src/memory/schema";
import {
	MemoryStore,
	READ_QUERY,
	rankedQuery,
	recentQuery,
	scopeClauses,
} from "../../src/memory/store";

const SPEC_COLUMNS = [
	"id",
	"agent_identity",
	"workset",
	"kind",
	"title",
	"body",
	"created_at",
	"updated_at",
];

const PLAN_BINDINGS = {
	identity: "alpha",
	workset: "dg",
	match: '"port"',
	id: "some-id",
	limit: 20,
	offset: 0,
};

let dgHome: string;
let paths: DgPaths;
let raw: Database;

function planFor(sql: string): string {
	const rows = raw.query(`EXPLAIN QUERY PLAN ${sql}`).all(PLAN_BINDINGS) as {
		detail: string;
	}[];
	return rows.map((row) => row.detail).join(" | ");
}

beforeEach(() => {
	dgHome = freshDgHome();
	paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
	const store = MemoryStore.open(paths);
	store.write({
		agentIdentity: "alpha",
		workset: "dg",
		title: "port bind race",
		body: "the harness raced itself",
	});
	store.close();
	raw = new Database(paths.memoryDbPath, { strict: true, readonly: true });
});

afterEach(() => {
	raw.close(true);
	cleanupDgHome(dgHome);
});

describe("the memory schema", () => {
	it("stamps the version the binary migrated it to", () => {
		expect(readSchemaVersion(raw)).toBe(CURRENT_MEMORY_SCHEMA_VERSION);
	});

	it("carries exactly the columns the store reads and writes", () => {
		const columns = (
			raw.query("PRAGMA table_info(memories)").all() as { name: string }[]
		).map((column) => column.name);

		expect(columns).toEqual(SPEC_COLUMNS);
	});

	it("refuses a body that is not text at all, because the table is STRICT", () => {
		const writable = new Database(paths.memoryDbPath, { strict: true });
		expect(() =>
			writable.run(
				"INSERT INTO memories (id, agent_identity, workset, kind, title, body, created_at, updated_at) VALUES ('x', 'alpha', NULL, 'note', 'title', x'0001', 'now', 'now')",
			),
		).toThrow("cannot store BLOB value in TEXT column");
		writable.close(true);
	});

	it("indexes title and body for full-text search, and the index agrees with the table", () => {
		const fts = raw
			.query(
				"SELECT sql FROM sqlite_master WHERE name = 'memories_fts' AND type = 'table'",
			)
			.get() as { sql: string } | null;

		expect(fts?.sql).toContain("fts5");
		expect(fts?.sql).toContain("title");
		expect(fts?.sql).toContain("body");

		const writable = new Database(paths.memoryDbPath, { strict: true });
		expect(() =>
			writable.run(
				"INSERT INTO memories_fts(memories_fts) VALUES('integrity-check')",
			),
		).not.toThrow();
		writable.close(true);
	});
});

describe("every lookup the store issues", () => {
	it("finds one agent's memories through the by-identity index", () => {
		const plan = planFor(
			recentQuery(scopeClauses({ agentIdentity: "a" }, "memories")),
		);

		expect(plan).toContain("SEARCH memories USING INDEX idx_memories_identity");
		expect(plan).not.toContain("SCAN");
		expect(plan).not.toContain("TEMP B-TREE");
	});

	it("finds one workset's memories through the by-workset index", () => {
		const plan = planFor(
			recentQuery(scopeClauses({ workset: "dg" }, "memories")),
		);

		expect(plan).toContain("SEARCH memories USING INDEX idx_memories_workset");
		expect(plan).not.toContain("SCAN");
		expect(plan).not.toContain("TEMP B-TREE");
	});

	it("reads one memory through its primary key", () => {
		expect(planFor(READ_QUERY)).toContain("SEARCH memories");
	});

	it("drives a ranked search off the full-text index and probes the row by rowid", () => {
		const plan = planFor(
			rankedQuery(scopeClauses({ agentIdentity: "a" }, "m")),
		);

		expect(plan).toContain("VIRTUAL TABLE INDEX 0:M");
		expect(plan).toContain("SEARCH m USING INTEGER PRIMARY KEY");
		expect(plan).not.toMatch(/SCAN m\b/);
	});
});

describe("the shared migration runner", () => {
	it("is the one the daemon store uses, not a private copy", () => {
		const source = readFileSync(
			join(import.meta.dir, "../../src/memory/store.ts"),
			"utf8",
		);
		const imported =
			/import\s*\{([^}]*)\}\s*from\s*"@dg\/common\/node";/.exec(source)?.[1] ??
			"";

		expect(imported).toContain("runMigrations");
	});

	it("refuses a memory database a newer build wrote", () => {
		const forward = new Database(paths.memoryDbPath, { strict: true });
		forward.run(`PRAGMA user_version = ${CURRENT_MEMORY_SCHEMA_VERSION + 1}`);
		forward.close(true);

		expect(() => MemoryStore.open(paths)).toThrow(ForwardOnlyVersionError);
	});
});
