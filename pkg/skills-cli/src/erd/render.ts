import * as path from "node:path";
import { escapeHtml } from "@dg/common";
import type {
	ArchitectureGraph,
	ClassRenderData,
	CodeEdge,
	CodeNode,
	CrossLink,
	DbColumn,
	DbEdge,
	DbNode,
	DiagramType,
	ErRenderData,
	FlowRenderData,
	MermaidPayload,
	RenderData,
	SequenceRenderData,
	StateRenderData,
} from "./graph";

export type TruncationReason = "depth" | "node-cap";

export interface RenderOptions {
	graph: ArchitectureGraph;
	truncationReason?: TruncationReason;
	type?: "er" | "flow";
}

export const MERMAID_VERSION = "12.2.0";
export const MERMAID_CDN_URL = `https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_VERSION}/dist/mermaid.esm.min.mjs`;

const STATIC_SCHEMA_NOTE_PREFIX = "Static schema parsed from:";

const EVIDENCE_PREVIEW_LIMIT = 10;

export function escapeMermaidText(label: string): string {
	return label.replace(/\r\n|\r|\n/g, " ").replace(/"/g, "#quot;");
}

/** Quoted form of {@link escapeMermaidText}, for grammar positions that accept a quoted string. */
export function escapeMermaidLabel(label: string): string {
	return `"${escapeMermaidText(label)}"`;
}

export function escapeMarkdownCell(value: string): string {
	const singleLine = value.replace(/\r\n|\r|\n/g, " ");
	return singleLine.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\|/g, "\\|");
}

function countLabel(count: number, singular: string): string {
	return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function dedupeEdges(edges: CodeEdge[]): CodeEdge[] {
	const seen = new Set<string>();
	const result: CodeEdge[] = [];
	for (const edge of edges) {
		const key = `${edge.from} ${edge.to} ${edge.kind}`;
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(edge);
	}
	return result;
}

function buildSummaryLine(graph: ArchitectureGraph, importCount: number): string {
	const fileCount = graph.codeNodes.filter((node) => node.kind === "file").length;
	const parts = [
		countLabel(fileCount, "file"),
		countLabel(graph.codeNodes.length - fileCount, "dir"),
		countLabel(importCount, "import"),
	];
	if (graph.dbNodes.length > 0) {
		parts.push(countLabel(graph.dbNodes.length, "table"), countLabel(graph.dbEdges.length, "relation"));
	}
	return `**Scope:** \`${escapeMarkdownCell(graph.scope)}\` — ${parts.join(" · ")}`;
}

interface TreeEntry {
	name: string;
	isDir: boolean;
	children: Map<string, TreeEntry>;
}

function buildTree(nodes: CodeNode[]): Map<string, TreeEntry> {
	const roots = new Map<string, TreeEntry>();
	for (const node of nodes) {
		const segments = node.id.split("/").filter((segment) => segment.length > 0);
		let level = roots;
		segments.forEach((segment, index) => {
			const isLast = index === segments.length - 1;
			let entry = level.get(segment);
			if (!entry) {
				entry = { name: segment, isDir: !isLast || node.kind === "dir", children: new Map() };
				level.set(segment, entry);
			} else if (!isLast) {
				entry.isDir = true;
			}
			level = entry.children;
		});
	}
	return roots;
}

function renderTreeLevel(level: Map<string, TreeEntry>, depth: number): string[] {
	const sorted = [...level.values()].sort((a, b) => {
		if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
	const lines: string[] = [];
	for (const entry of sorted) {
		const suffix = entry.isDir ? "/" : "";
		lines.push(`${"  ".repeat(depth)}- ${escapeMarkdownCell(entry.name)}${suffix}`);
		lines.push(...renderTreeLevel(entry.children, depth + 1));
	}
	return lines;
}

function buildDirTreeSection(graph: ArchitectureGraph): string {
	const lines = renderTreeLevel(buildTree(graph.codeNodes), 0);
	return ["## Directory Tree", "", ...(lines.length > 0 ? lines : ["(no code nodes)"])].join("\n");
}

function buildModuleTable(graph: ArchitectureGraph, edges: CodeEdge[]): string {
	const header = "| Module | Imports | Imported by |";
	const divider = "| --- | --- | --- |";

	const outDegree = new Map<string, number>();
	const inDegree = new Map<string, number>();
	for (const edge of edges) {
		outDegree.set(edge.from, (outDegree.get(edge.from) ?? 0) + 1);
		inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
	}

	const rows = graph.codeNodes
		.filter((node) => node.kind === "file")
		.map((node) => ({ id: node.id, out: outDegree.get(node.id) ?? 0, in: inDegree.get(node.id) ?? 0 }))
		.sort((a, b) => b.out + b.in - (a.out + a.in) || a.id.localeCompare(b.id))
		.map((row) => `| ${escapeMarkdownCell(row.id)} | ${row.out} | ${row.in} |`);

	return ["## Modules", "", header, divider, ...(rows.length > 0 ? rows : ["| (no files) | | |"])].join("\n");
}

function buildLabelMap(nodes: CodeNode[]): Map<string, string> {
	const byBasename = new Map<string, number>();
	for (const node of nodes) {
		const name = path.posix.basename(node.id);
		byBasename.set(name, (byBasename.get(name) ?? 0) + 1);
	}
	const labels = new Map<string, string>();
	for (const node of nodes) {
		const name = path.posix.basename(node.id);
		labels.set(node.id, (byBasename.get(name) ?? 0) > 1 ? node.id : name);
	}
	return labels;
}

/** Sole constructor of `graph LR` Mermaid syntax, with {@link buildSchemaErDiagram}. */
export function buildImportFlowchart(graph: ArchitectureGraph): string {
	if (graph.codeNodes.length === 0) return "";

	const edges = dedupeEdges(graph.codeEdges);
	const connected = new Set(edges.flatMap((edge) => [edge.from, edge.to]));
	const nodes = edges.length > 0 ? graph.codeNodes.filter((node) => connected.has(node.id)) : graph.codeNodes;
	const labels = buildLabelMap(nodes);
	const mermaidId = createMermaidIdResolver();

	const lines: string[] = ["graph LR"];
	for (const node of nodes) {
		lines.push(`  ${mermaidId(node.id)}[${escapeMermaidLabel(labels.get(node.id) ?? node.id)}]`);
	}
	for (const edge of edges) {
		lines.push(`  ${mermaidId(edge.from)} -->|${escapeMermaidText(edge.kind)}| ${mermaidId(edge.to)}`);
	}
	return lines.join("\n");
}

function dbEdgeSyntax(confidence: DbEdge["confidence"]): "--" | ".." {
	return confidence === "proven" ? "--" : "..";
}

function columnKeyMarker(column: DbColumn): string {
	if (column.isPrimaryKey) return " PK";
	return column.isForeignKey ? " FK" : "";
}

const ATTRIBUTE_WORD_UNSAFE = /[^A-Za-z0-9_\-()[\]]/g;

/** erDiagram attribute type/name must be a bare ATTRIBUTE_WORD token, never a quoted string. */
function mermaidAttributeWord(value: string): string {
	const sanitized = value.replace(ATTRIBUTE_WORD_UNSAFE, "_");
	const nonEmpty = sanitized.length > 0 ? sanitized : "_";
	return /^[0-9]/.test(nonEmpty) ? `_${nonEmpty}` : nonEmpty;
}

function buildErDiagramEntity(node: DbNode, mermaidId: MermaidIdResolver): string {
	const lines = [`  ${mermaidId(node.id)} {`];
	for (const column of node.columns) {
		const label = `${mermaidAttributeWord(column.dataType)} ${mermaidAttributeWord(column.name)}`;
		lines.push(`    ${label}${columnKeyMarker(column)}`);
	}
	lines.push("  }");
	return lines.join("\n");
}

/** Sole constructor of `erDiagram` Mermaid syntax, with {@link buildImportFlowchart}. */
export function buildSchemaErDiagram(graph: ArchitectureGraph): string {
	if (graph.dbNodes.length === 0) return "";

	const mermaidId = createMermaidIdResolver();
	const lines: string[] = ["erDiagram"];
	for (const edge of graph.dbEdges) {
		const lineStyle = dbEdgeSyntax(edge.confidence);
		lines.push(
			`  ${mermaidId(edge.from)} }o${lineStyle}|| ${mermaidId(edge.to)} : ${escapeMermaidLabel(edge.toColumn)}`,
		);
	}
	for (const node of graph.dbNodes) {
		lines.push(buildErDiagramEntity(node, mermaidId));
	}
	return lines.join("\n");
}

function sanitizeMermaidId(rawId: string): string {
	const sanitized = rawId.replace(/[^a-zA-Z0-9_]/g, "_");
	const nonEmpty = sanitized.length > 0 ? sanitized : "node";
	return /^[0-9]/.test(nonEmpty) ? `node_${nonEmpty}` : nonEmpty;
}

export type MermaidIdResolver = (rawId: string) => string;

/** The label carries the untrusted content instead; this only needs a stable, safe placeholder, unique within one diagram even when two raw ids sanitize to the same characters (e.g. "a-b" and "a_b"). */
export function createMermaidIdResolver(): MermaidIdResolver {
	const assigned = new Map<string, string>();
	const used = new Set<string>();
	return (rawId: string) => {
		const existing = assigned.get(rawId);
		if (existing !== undefined) return existing;
		const base = sanitizeMermaidId(rawId);
		let candidate = base;
		for (let suffix = 2; used.has(candidate); suffix++) {
			candidate = `${base}_${suffix}`;
		}
		used.add(candidate);
		assigned.set(rawId, candidate);
		return candidate;
	};
}

function sequenceArrow(kind: SequenceRenderData["messages"][number]["kind"]): string {
	if (kind === "async") return "-)";
	if (kind === "return") return "-->>";
	return "->>";
}

export function buildSequenceDiagram(data: SequenceRenderData): string {
	const mermaidId = createMermaidIdResolver();
	const lines = ["sequenceDiagram"];
	for (const participant of data.participants) {
		lines.push(`  participant ${mermaidId(participant)} as ${escapeMermaidLabel(participant)}`);
	}
	for (const message of data.messages) {
		const arrow = sequenceArrow(message.kind);
		lines.push(
			`  ${mermaidId(message.from)}${arrow}${mermaidId(message.to)}: ${escapeMermaidText(message.label)}`,
		);
	}
	return lines.join("\n");
}

export function buildStateDiagram(data: StateRenderData): string {
	const mermaidId = createMermaidIdResolver();
	const lines = ["stateDiagram-v2"];
	for (const state of data.states) {
		lines.push(`  state ${escapeMermaidLabel(state)} as ${mermaidId(state)}`);
	}
	if (data.initial) lines.push(`  [*] --> ${mermaidId(data.initial)}`);
	for (const transition of data.transitions) {
		const label = transition.label ? ` : ${escapeMermaidText(transition.label)}` : "";
		lines.push(`  ${mermaidId(transition.from)} --> ${mermaidId(transition.to)}${label}`);
	}
	return lines.join("\n");
}

function classRelation(kind: ClassRenderData["relations"][number]["kind"]): string {
	if (kind === "extends") return "<|--";
	if (kind === "implements") return "<|..";
	if (kind === "composes") return "*--";
	return "-->";
}

export function buildClassDiagram(data: ClassRenderData): string {
	const mermaidId = createMermaidIdResolver();
	const lines = ["classDiagram"];
	for (const item of data.classes) {
		const id = mermaidId(item.name);
		lines.push(`  class ${id}[${escapeMermaidLabel(item.name)}] {`);
		for (const field of item.fields ?? []) lines.push(`    +${escapeMermaidText(field)}`);
		for (const method of item.methods ?? []) lines.push(`    +${escapeMermaidText(method)}`);
		lines.push("  }");
	}
	for (const relation of data.relations) {
		const inheritance = relation.kind === "extends" || relation.kind === "implements";
		const left = inheritance ? relation.to : relation.from;
		const right = inheritance ? relation.from : relation.to;
		lines.push(
			`  ${mermaidId(left)} ${classRelation(relation.kind)} ${mermaidId(right)} : ${escapeMermaidText(relation.kind)}`,
		);
	}
	return lines.join("\n");
}

function toArchitectureGraph(code: FlowRenderData, db: ErRenderData): ArchitectureGraph {
	return {
		scope: "render-data",
		codeNodes: code.nodes,
		codeEdges: code.edges,
		dbNodes: db.nodes,
		dbEdges: db.edges,
		crossLinks: [],
		evidence: [],
		truncated: { codeNodes: 0, codeEdges: 0, dbNodes: 0, dbEdges: 0 },
		generatedAt: new Date().toISOString(),
	};
}

export function buildDiagram(type: DiagramType, data: RenderData): MermaidPayload {
	if (type === "sequence") {
		return { diagram: buildSequenceDiagram(data as SequenceRenderData), title: "Sequence Diagram" };
	}
	if (type === "state") {
		return { diagram: buildStateDiagram(data as StateRenderData), title: "State Diagram" };
	}
	if (type === "class") {
		return { diagram: buildClassDiagram(data as ClassRenderData), title: "Class Diagram" };
	}
	if (type === "er") {
		const er = data as ErRenderData;
		return {
			diagram: buildSchemaErDiagram(toArchitectureGraph({ nodes: [], edges: [] }, er)) || "erDiagram",
			title: "Database Schema",
		};
	}
	const flow = data as FlowRenderData;
	return {
		diagram: buildImportFlowchart(toArchitectureGraph(flow, { nodes: [], edges: [] })) || "graph LR",
		title: "Flow Diagram",
	};
}

export function renderDiagramMarkdown(payload: MermaidPayload): string {
	const heading = payload.title ? `## ${escapeMarkdownCell(payload.title)}\n\n` : "";
	const caption = payload.caption ? `\n\n${escapeMarkdownCell(payload.caption)}` : "";
	return `${heading}\`\`\`mermaid\n${payload.diagram}\n\`\`\`${caption}`;
}

export function renderHtml(payloads: MermaidPayload[], pageTitle = "Mermaid diagrams"): string {
	const diagrams = payloads
		.map((payload) => {
			const title = payload.title ? `<h2>${escapeHtml(payload.title)}</h2>` : "";
			const caption = payload.caption ? `<p>${escapeHtml(payload.caption)}</p>` : "";
			return `<section>${title}<pre class="mermaid">${escapeHtml(payload.diagram)}</pre>${caption}</section>`;
		})
		.join("\n");
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(pageTitle)}</title>
<style>
:root { color-scheme: light dark; --bg: #ffffff; --fg: #172033; --panel: #f6f8fa; --border: #d0d7de; }
@media (prefers-color-scheme: dark) { :root { --bg: #0d1117; --fg: #e6edf3; --panel: #161b22; --border: #30363d; } }
body { margin: 0 auto; max-width: 88rem; padding: 2rem; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
section { margin: 0 0 2rem; padding: 1.25rem; overflow-x: auto; background: var(--panel); border: 1px solid var(--border); border-radius: 0.75rem; }
.mermaid { display: flex; justify-content: center; }
</style>
</head>
<body>
<h1>${escapeHtml(pageTitle)}</h1>
${diagrams}
<script type="module">
import mermaid from "${MERMAID_CDN_URL}";
const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
mermaid.initialize({ startOnLoad: true, theme: dark ? "dark" : "default", securityLevel: "strict" });
</script>
</body>
</html>
`;
}

function buildCrossLinkTable(crossLinks: CrossLink[]): string {
	const header = "| Code Symbol | DB Table | Match Basis | Confidence |";
	const divider = "| --- | --- | --- | --- |";
	if (crossLinks.length === 0) {
		return ["## Code ↔ Schema Cross-Links", "", header, divider, "| no cross-links found | | | |"].join("\n");
	}
	const rows = crossLinks.map(
		(link) =>
			`| ${escapeMarkdownCell(link.codeNodeId)} | ${escapeMarkdownCell(link.dbNodeId)} | ${escapeMarkdownCell(link.evidence)} | heuristic |`,
	);
	return ["## Code ↔ Schema Cross-Links", "", header, divider, ...rows].join("\n");
}

function buildEvidenceAppendix(graph: ArchitectureGraph): string {
	const byType = new Map<string, string[]>();
	for (const record of graph.evidence) {
		const detail = record.detail ? ` — ${escapeMarkdownCell(record.detail)}` : "";
		const line = `- [${escapeMarkdownCell(record.type)}] ${escapeMarkdownCell(record.ref)}${detail}`;
		const bucket = byType.get(record.type);
		if (bucket) bucket.push(line);
		else byType.set(record.type, [line]);
	}

	const rows: string[] = [];
	for (const [type, lines] of byType) {
		rows.push(...lines.slice(0, EVIDENCE_PREVIEW_LIMIT));
		const hidden = lines.length - EVIDENCE_PREVIEW_LIMIT;
		if (hidden > 0) {
			rows.push(`- ...and ${countLabel(hidden, `more [${type}] record`)} — full list in the .json sidecar.`);
		}
	}

	return ["## Evidence", "", ...(rows.length > 0 ? rows : ["(no evidence recorded)"])].join("\n");
}

function findStaticSchemaNote(graph: ArchitectureGraph): string | undefined {
	const record = graph.evidence.find((entry) => entry.detail?.startsWith(STATIC_SCHEMA_NOTE_PREFIX));
	return record?.detail;
}

function buildTruncationNote(graph: ArchitectureGraph, reason: TruncationReason): string | undefined {
	const { codeNodes, codeEdges, dbNodes, dbEdges } = graph.truncated;
	const total = codeNodes + codeEdges + dbNodes + dbEdges;
	if (total === 0) return undefined;
	const cause = reason === "node-cap" ? "the default node-count safety limit" : "depth cap";
	return `> ${total} nodes/edges truncated at ${cause}.`;
}

export function renderMarkdown(opts: RenderOptions): string {
	const { graph } = opts;
	if (opts.type === "flow") {
		const diagram = buildImportFlowchart(graph) || "graph LR";
		return renderDiagramMarkdown({ diagram, title: "Import Graph" });
	}
	if (opts.type === "er") {
		const diagram = buildSchemaErDiagram(graph) || "erDiagram";
		return renderDiagramMarkdown({ diagram, title: "Database Schema" });
	}
	const edges = dedupeEdges(graph.codeEdges);
	const sections: string[] = [buildSummaryLine(graph, edges.length)];

	const truncationNote = buildTruncationNote(graph, opts.truncationReason ?? "depth");
	if (truncationNote) sections.push(truncationNote);

	sections.push(buildDirTreeSection(graph));
	sections.push(buildModuleTable(graph, edges));

	const importDiagram = buildImportFlowchart(graph);
	if (importDiagram) {
		sections.push(["## Import Graph", "", "```mermaid", importDiagram, "```"].join("\n"));
	}

	if (graph.dbNodes.length > 0) {
		const schemaDiagram = buildSchemaErDiagram(graph);
		const dbSectionParts = ["## Database Schema", ""];
		const staticSchemaNote = findStaticSchemaNote(graph);
		if (staticSchemaNote) dbSectionParts.push(staticSchemaNote, "");
		dbSectionParts.push("```mermaid", schemaDiagram, "```");
		sections.push(dbSectionParts.join("\n"));
	}

	sections.push(buildCrossLinkTable(graph.crossLinks));
	sections.push(buildEvidenceAppendix(graph));

	return sections.join("\n\n");
}

export function architecturePayloads(graph: ArchitectureGraph, type?: "er" | "flow"): MermaidPayload[] {
	if (type === "flow") {
		return [{ diagram: buildImportFlowchart(graph) || "graph LR", title: "Import Graph" }];
	}
	if (type === "er") {
		return [{ diagram: buildSchemaErDiagram(graph) || "erDiagram", title: "Database Schema" }];
	}
	const payloads: MermaidPayload[] = [];
	const flow = buildImportFlowchart(graph);
	if (flow) payloads.push({ diagram: flow, title: "Import Graph" });
	const er = buildSchemaErDiagram(graph);
	if (er) payloads.push({ diagram: er, title: "Database Schema" });
	return payloads;
}
