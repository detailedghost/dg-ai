import { spawn } from "node:child_process";
import { selfCommand } from "@dg/common/node";
import type { DbColumn, DbEdge, DbNode, EvidenceRecord } from "./graph";

export interface CollectLiveSchemaOptions {
	connNames?: string[];
	runDb?: DbRunner;
}

export interface CollectLiveSchemaResult {
	nodes: DbNode[];
	edges: DbEdge[];
	evidence: EvidenceRecord[];
	usedConnection?: string;
}

function emptyResult(): CollectLiveSchemaResult {
	return { nodes: [], edges: [], evidence: [] };
}

interface DbSchemaColumn {
	name: string;
	dataType: string;
	nullable: boolean;
	isPrimaryKey: boolean;
	isForeignKey: boolean;
}

interface DbSchemaForeignKey {
	column: string;
	refTable: string;
	refColumn: string;
}

interface DbSchemaTable {
	name: string;
	schema: string;
	columns: DbSchemaColumn[];
	foreignKeys: DbSchemaForeignKey[];
}

interface DbSchemaResponse {
	tables: DbSchemaTable[];
}

export const DB_SHELLOUT_TIMEOUT_MS = 5000;

export type DbRunner = (argv: string[]) => Promise<{ ok: boolean; stdout: string }>;

export interface DbRunnerDeps {
	selfCommand(args: string[]): string[];
	spawn: typeof spawn;
}

export function createDbRunner(overrides: Partial<DbRunnerDeps> = {}): DbRunner {
	const deps: DbRunnerDeps = { selfCommand, spawn, ...overrides };
	return (argv) => new Promise((resolve) => {
		let settled = false;
		let stdout = "";
		let child: ReturnType<typeof spawn>;
		try {
			const command = deps.selfCommand(["db", ...argv]);
			child = deps.spawn(command[0] as string, command.slice(1), { env: process.env });
		} catch {
			resolve({ ok: false, stdout: "" });
			return;
		}

		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill();
			resolve({ ok: false, stdout: "" });
		}, DB_SHELLOUT_TIMEOUT_MS);

		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf-8");
		});
		child.on("error", () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ ok: false, stdout: "" });
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ ok: code === 0, stdout });
		});
	});
}

export const runDb = createDbRunner();

function parseConnectionNames(stdout: string): string[] {
	const lines = stdout.split("\n").filter(Boolean);
	if (lines.length === 0) return [];
	const countMatch = lines[0]?.match(/^CONNECTIONS:\s*(\d+)/);
	if (!countMatch || countMatch[1] === "0") return [];
	return lines
		.slice(2)
		.map((line) => line.split("\t")[0] ?? "")
		.filter(Boolean);
}

function buildResultFromResponse(conn: string, response: DbSchemaResponse): CollectLiveSchemaResult {
	const nodes: DbNode[] = response.tables.map((table) => {
		const columns: DbColumn[] = table.columns.map((col) => ({
			name: col.name,
			dataType: col.dataType,
			nullable: col.nullable,
			isPrimaryKey: col.isPrimaryKey,
			isForeignKey: col.isForeignKey,
		}));
		return {
			id: `${table.schema}.${table.name}`,
			label: table.name,
			schema: table.schema,
			columns,
			source: "live",
		};
	});

	const edges: DbEdge[] = response.tables.flatMap((table) =>
		table.foreignKeys.map((fk) => ({
			from: `${table.schema}.${table.name}`,
			to: `${table.schema}.${fk.refTable}`,
			fromColumn: fk.column,
			toColumn: fk.refColumn,
			confidence: "proven" as const,
		})),
	);

	const evidence: EvidenceRecord[] = response.tables.map((table) => ({
		type: "db-table",
		ref: `${table.schema}.${table.name}`,
		detail: `live schema via db schema ${conn}`,
	}));

	return { nodes, edges, evidence, usedConnection: conn };
}

interface SchemaAttempt {
	result?: CollectLiveSchemaResult;
	evidence?: EvidenceRecord;
}

async function trySchema(conn: string, runner: DbRunner): Promise<SchemaAttempt> {
	const { ok, stdout } = await runner(["schema", conn]);
	if (!ok) return {};

	let parsed: DbSchemaResponse;
	try {
		parsed = JSON.parse(stdout) as DbSchemaResponse;
	} catch (err) {
		return {
			evidence: {
				type: "file",
				ref: conn,
				detail: `skipped: live schema response was not valid JSON (${(err as Error).message})`,
			},
		};
	}
	if (!parsed || !Array.isArray(parsed.tables)) {
		return {
			evidence: {
				type: "file",
				ref: conn,
				detail: "skipped: live schema response did not match the expected shape",
			},
		};
	}

	return { result: buildResultFromResponse(conn, parsed) };
}

export async function collectLiveSchema(opts: CollectLiveSchemaOptions): Promise<CollectLiveSchemaResult> {
	const evidence: EvidenceRecord[] = [];
	try {
		const runner = opts.runDb ?? runDb;
		const candidates = opts.connNames ?? parseConnectionNames((await runner(["connections"])).stdout);

		for (const conn of candidates) {
			const attempt = await trySchema(conn, runner);
			if (attempt.evidence) evidence.push(attempt.evidence);
			if (attempt.result) {
				return { ...attempt.result, evidence: [...evidence, ...attempt.result.evidence] };
			}
		}

		return { ...emptyResult(), evidence };
	} catch (err) {
		evidence.push({
			type: "file",
			ref: "live-schema",
			detail: `skipped: live schema collection failed (${(err as Error).message})`,
		});
		return { ...emptyResult(), evidence };
	}
}
