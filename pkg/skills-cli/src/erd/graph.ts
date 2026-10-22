import * as path from "node:path";

export interface CodeNode {
	id: string;
	label: string;
	kind: "dir" | "file";
	sizeBytes?: number;
	fileCount?: number;
	language?: string;
}

export interface CodeEdge {
	from: string;
	to: string;
	kind: "import";
	evidence: string;
}

export interface DbColumn {
	name: string;
	dataType: string;
	nullable: boolean;
	isPrimaryKey?: boolean;
	isForeignKey?: boolean;
}

export interface DbNode {
	id: string;
	label: string;
	schema: string;
	columns: DbColumn[];
	source: "live" | "static-sql" | "static-prisma" | "static-ef" | "static-dbt";
}

export interface DbEdge {
	from: string;
	to: string;
	fromColumn: string;
	toColumn: string;
	confidence: "proven" | "inferred";
}

export interface CrossLink {
	codeNodeId: string;
	dbNodeId: string;
	evidence: string;
}

export type EvidenceType = "db-table" | "db-column" | "file" | "import";

export interface EvidenceRecord {
	type: EvidenceType;
	ref: string;
	detail?: string;
}

export interface ArchitectureGraph {
	scope: string;
	codeNodes: CodeNode[];
	codeEdges: CodeEdge[];
	dbNodes: DbNode[];
	dbEdges: DbEdge[];
	crossLinks: CrossLink[];
	evidence: EvidenceRecord[];
	truncated: { codeNodes: number; codeEdges: number; dbNodes: number };
	generatedAt: string;
}

export interface MermaidPayload {
	diagram: string;
	title?: string;
	caption?: string;
}

export type DiagramType = "er" | "flow" | "sequence" | "state" | "class";

export interface ErRenderData {
	nodes: DbNode[];
	edges: DbEdge[];
}

export interface FlowRenderData {
	nodes: CodeNode[];
	edges: CodeEdge[];
}

export interface SequenceRenderData {
	participants: string[];
	messages: Array<{
		from: string;
		to: string;
		label: string;
		kind?: "sync" | "async" | "return";
	}>;
}

export interface StateRenderData {
	states: string[];
	initial?: string;
	transitions: Array<{ from: string; to: string; label?: string }>;
}

export interface ClassRenderData {
	classes: Array<{ name: string; fields?: string[]; methods?: string[] }>;
	relations: Array<{
		from: string;
		to: string;
		kind: "extends" | "implements" | "composes" | "uses";
	}>;
}

export type RenderData =
	| ErRenderData
	| FlowRenderData
	| SequenceRenderData
	| StateRenderData
	| ClassRenderData;

interface CodePartial {
	nodes: CodeNode[];
	edges: CodeEdge[];
	evidence: EvidenceRecord[];
	truncated: { nodes: number; edges: number };
}

export interface DbPartial {
	nodes: DbNode[];
	edges: DbEdge[];
	evidence: EvidenceRecord[];
	truncated: { nodes: number };
}

export interface MergeGraphInput {
	scope: string;
	code?: CodePartial;
	db?: DbPartial;
}

function normalizeToken(raw: string): string {
	const base = raw.replace(/\.[^./]+$/, "");
	const lower = base.toLowerCase();
	if (lower.endsWith("es")) return lower.slice(0, -2);
	if (lower.endsWith("s")) return lower.slice(0, -1);
	return lower;
}

function dedupeById<T extends { id: string }>(nodes: T[]): T[] {
	const seen = new Set<string>();
	const result: T[] = [];
	for (const node of nodes) {
		if (seen.has(node.id)) continue;
		seen.add(node.id);
		result.push(node);
	}
	return result;
}

export function mergeGraph(parts: MergeGraphInput): ArchitectureGraph {
	const code: CodePartial = parts.code ?? {
		nodes: [],
		edges: [],
		evidence: [],
		truncated: { nodes: 0, edges: 0 },
	};
	const db: DbPartial = parts.db ?? {
		nodes: [],
		edges: [],
		evidence: [],
		truncated: { nodes: 0 },
	};

	const codeNodes = dedupeById(code.nodes);
	const dbNodes = dedupeById(db.nodes);

	const dbNodesByToken = new Map<string, DbNode[]>();
	for (const dbNode of dbNodes) {
		const dbToken = normalizeToken(dbNode.label);
		const bucket = dbNodesByToken.get(dbToken);
		if (bucket) bucket.push(dbNode);
		else dbNodesByToken.set(dbToken, [dbNode]);
	}

	const crossLinks: CrossLink[] = [];
	for (const codeNode of codeNodes) {
		if (codeNode.kind !== "file") continue;
		const codeToken = normalizeToken(path.posix.basename(codeNode.id));
		for (const dbNode of dbNodesByToken.get(codeToken) ?? []) {
			crossLinks.push({
				codeNodeId: codeNode.id,
				dbNodeId: dbNode.id,
				evidence: `${codeNode.id} <-> ${dbNode.id} (normalized token match: "${codeToken}")`,
			});
		}
	}

	return {
		scope: parts.scope,
		codeNodes,
		codeEdges: code.edges,
		dbNodes,
		dbEdges: db.edges,
		crossLinks,
		evidence: [...code.evidence, ...db.evidence],
		truncated: {
			codeNodes: code.truncated.nodes,
			codeEdges: code.truncated.edges,
			dbNodes: db.truncated.nodes,
		},
		generatedAt: new Date().toISOString(),
	};
}
