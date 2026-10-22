import * as crypto from "node:crypto";
import { statSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { agentsPath, isWSL, tryOpen } from "@dg/common/node";
import { collectCodeGraph } from "./code-graph";
import type { ArchitectureGraph, DbPartial, DiagramType, EvidenceRecord, MermaidPayload, RenderData } from "./graph";
import { mergeGraph } from "./graph";
import { collectImportGraph } from "./import-graph";
import { checkGitignored, persistArchitecture, persistHtml } from "./persist";
import {
	architecturePayloads,
	buildDiagram,
	renderDiagramMarkdown,
	renderHtml,
	renderMarkdown,
} from "./render";
import { defaultErdResolveDeps, detectErdInputKind, type ErdCandidate, resolveErdFuzzy } from "./resolve";
import { collectLiveSchema } from "./schema-live";
import { collectStaticSchema } from "./schema-static";

export const DEFAULT_MAX_TOTAL_NODES = 7500;

export interface GenerateOptions {
	scope: string;
	depth?: number;
	outPath?: string;
	type?: "er" | "flow";
	html?: boolean;
}

export interface GenerateResult {
	scope: string;
	outPath: string;
	evidenceOutPath: string;
	stats: { codeNodes: number; codeEdges: number; dbNodes: number; dbEdges: number; evidenceCount: number };
	truncated: { codeNodes: number; codeEdges: number; dbNodes: number };
	evidence: EvidenceRecord[];
	gitignoreWarning?: string;
	htmlOutPath?: string;
}

const SLUG_MAX = 180;

function scopeSlug(scope: string): string {
	if (scope === "." || scope === "") return "root";
	const safe = scope.replace(/[^a-zA-Z0-9._-]/g, "_").toLowerCase();
	if (safe.length <= SLUG_MAX) return safe;
	const suffix = crypto.createHash("sha256").update(scope, "utf8").digest("hex").slice(0, 8);
	return `${safe.slice(0, SLUG_MAX)}_${suffix}`;
}

async function collectDbPartial(scope: string): Promise<DbPartial> {
	try {
		const live = await collectLiveSchema({});
		if (live.nodes.length > 0) {
			return { nodes: live.nodes, edges: live.edges, evidence: live.evidence, truncated: { nodes: 0 } };
		}
		const fromStatic = collectStaticSchema(scope);
		return {
			nodes: fromStatic.nodes,
			edges: fromStatic.edges,
			evidence: [...live.evidence, ...fromStatic.evidence],
			truncated: { nodes: 0 },
		};
	} catch {
		return { nodes: [], edges: [], evidence: [], truncated: { nodes: 0 } };
	}
}

function applyGlobalNodeCap(graph: ArchitectureGraph, depthProvided: boolean): ArchitectureGraph {
	if (depthProvided) return graph;

	const totalCodeNodes = graph.codeNodes.length;
	const totalDbNodes = graph.dbNodes.length;
	const total = totalCodeNodes + totalDbNodes;
	if (total <= DEFAULT_MAX_TOTAL_NODES) return graph;

	const halfCap = Math.floor(DEFAULT_MAX_TOTAL_NODES / 2);
	let keepCode = Math.min(totalCodeNodes, halfCap);
	let keepDb = Math.min(totalDbNodes, halfCap);
	const leftover = DEFAULT_MAX_TOTAL_NODES - keepCode - keepDb;
	if (leftover > 0) {
		if (totalCodeNodes > keepCode) keepCode = Math.min(totalCodeNodes, keepCode + leftover);
		else if (totalDbNodes > keepDb) keepDb = Math.min(totalDbNodes, keepDb + leftover);
	}

	const droppedCodeCount = totalCodeNodes - keepCode;
	const droppedDbCount = totalDbNodes - keepDb;
	if (droppedCodeCount <= 0 && droppedDbCount <= 0) return graph;

	const keptCodeNodes = graph.codeNodes.slice(0, keepCode);
	const keptCodeIds = new Set(keptCodeNodes.map((n) => n.id));
	const keptCodeEdges = graph.codeEdges.filter((e) => keptCodeIds.has(e.from) && keptCodeIds.has(e.to));

	const keptDbNodes = graph.dbNodes.slice(0, keepDb);
	const keptDbIds = new Set(keptDbNodes.map((n) => n.id));
	const keptDbEdges = graph.dbEdges.filter((e) => keptDbIds.has(e.from) && keptDbIds.has(e.to));

	const droppedTotal = droppedCodeCount + droppedDbCount;

	return {
		...graph,
		codeNodes: keptCodeNodes,
		codeEdges: keptCodeEdges,
		dbNodes: keptDbNodes,
		dbEdges: keptDbEdges,
		truncated: {
			...graph.truncated,
			codeNodes: graph.truncated.codeNodes + droppedCodeCount,
			dbNodes: graph.truncated.dbNodes + droppedDbCount,
		},
		evidence: [
			...graph.evidence,
			{
				type: "file",
				ref: graph.scope,
				detail: `${droppedTotal} nodes truncated at DEFAULT_MAX_TOTAL_NODES safety cap (${DEFAULT_MAX_TOTAL_NODES})`,
			},
		],
	};
}

/** Returns ErdCandidate[] for an unresolved fuzzy scope; a GenerateResult otherwise. */
export async function generateArchitecture(opts: GenerateOptions): Promise<GenerateResult | ErdCandidate[]> {
	if (detectErdInputKind(opts.scope) === "fuzzy") {
		return resolveErdFuzzy(opts.scope, defaultErdResolveDeps);
	}

	const { scope, depth } = opts;

	const dbPartialPromise = collectDbPartial(scope);

	const codePartialPromise = Promise.all([
		Promise.resolve().then(() => collectCodeGraph({ scopePath: scope, depth })),
		Promise.resolve().then(() => collectImportGraph({ scopePath: scope, depth })),
	]).then(([codeGraph, importGraph]) => ({
		nodes: codeGraph.nodes,
		edges: importGraph.edges,
		evidence: [...codeGraph.evidence, ...importGraph.evidence],
		truncated: { nodes: codeGraph.truncated.nodes, edges: importGraph.truncated.edges },
	}));

	const [codePartial, dbPartial] = await Promise.all([codePartialPromise, dbPartialPromise]);

	const depthProvided = depth !== undefined;
	const merged = applyGlobalNodeCap(mergeGraph({ scope, code: codePartial, db: dbPartial }), depthProvided);
	const markdown = renderMarkdown({
		graph: merged,
		truncationReason: depthProvided ? "depth" : "node-cap",
		type: opts.type,
	});

	const outBasePath = opts.outPath ?? agentsPath("architecture", scopeSlug(scope));
	const { outPath, evidenceOutPath } = persistArchitecture(merged, markdown, outBasePath);

	const result: GenerateResult = {
		scope,
		outPath,
		evidenceOutPath,
		stats: {
			codeNodes: merged.codeNodes.length,
			codeEdges: merged.codeEdges.length,
			dbNodes: merged.dbNodes.length,
			dbEdges: merged.dbEdges.length,
			evidenceCount: merged.evidence.length,
		},
		truncated: merged.truncated,
		evidence: merged.evidence,
	};
	if (opts.html) {
		result.htmlOutPath = persistHtml(
			renderHtml(architecturePayloads(merged, opts.type), `Architecture: ${scope}`),
			outBasePath,
		);
	}

	if (!checkGitignored(outPath)) {
		result.gitignoreWarning = `${outPath} is not gitignored — architecture snapshots can carry path/schema detail worth keeping out of git history.`;
	}

	return result;
}

export interface RenderResult {
	type: DiagramType;
	outPath: string;
	dataOutPath: string;
	payload: MermaidPayload;
	htmlOutPath?: string;
}

export interface ErdDeps {
	openHtml(path: string): Promise<{ opened: boolean; environment: "wsl" | "local" }>;
	readData(path: string): Promise<string>;
}

const defaultDeps: ErdDeps = {
	openHtml: async (path) => ({
		opened: await tryOpen(pathToFileURL(path).href),
		environment: isWSL() ? "wsl" : "local",
	}),
	readData: async (path) =>
		path === "-" ? new Response(Bun.stdin.stream()).text() : Bun.file(path).text(),
};

const DIAGRAM_TYPES = new Set<DiagramType>(["er", "flow", "sequence", "state", "class"]);

const USAGE = `Usage: dg-skills erd resolve <concept-or-path>
       dg-skills erd generate [scope] [--depth N] [--out <path>] [--type er|flow] [--html]
       dg-skills erd render --type <er|flow|sequence|state|class> --data <file|-> [--out <path>] [--html]
`;

interface ParsedOptions {
	positionals: string[];
	depth?: number;
	out?: string;
	type?: DiagramType;
	data?: string;
	html: boolean;
}

function parseOptions(args: string[], legacyGenerate = false): ParsedOptions {
	const parsed: ParsedOptions = { positionals: [], html: false };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (arg === "--html") {
			parsed.html = true;
			continue;
		}
		if (arg === "--depth" || arg === "--out" || arg === "--type" || arg === "--data") {
			const value = args[i + 1];
			if (value === undefined || value.startsWith("--")) {
				if (legacyGenerate && (arg === "--depth" || arg === "--out")) continue;
				throw new Error(`${arg} requires a value`);
			}
			i++;
			if (arg === "--depth") {
				const depth = Number.parseInt(value, 10);
				if (Number.isFinite(depth)) parsed.depth = depth;
			} else if (arg === "--out") parsed.out = value;
			else if (arg === "--data") parsed.data = value;
			else {
				if (!DIAGRAM_TYPES.has(value as DiagramType)) throw new Error(`unknown diagram type: ${value}`);
				parsed.type = value as DiagramType;
			}
			continue;
		}
		if (arg.startsWith("-")) throw new Error(`unknown flag: ${arg}`);
		parsed.positionals.push(arg);
	}
	return parsed;
}

function stripOutputSuffix(outPath: string): string {
	return outPath.replace(/\.(?:md|json|html)$/i, "");
}

function stripMarkdownSuffix(outPath: string): string {
	return /\.md$/i.test(outPath) ? outPath.slice(0, -3) : outPath;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, context: string): Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`${context} must be a JSON object`);
	return value;
}

function requireString(record: Record<string, unknown>, field: string, context: string): string {
	const value = record[field];
	if (typeof value !== "string") throw new Error(`${context}.${field} must be a string`);
	return value;
}

function requireBoolean(record: Record<string, unknown>, field: string, context: string): void {
	if (typeof record[field] !== "boolean") throw new Error(`${context}.${field} must be a boolean`);
}

function requireArray(record: Record<string, unknown>, field: string, context: string): unknown[] {
	const value = record[field];
	if (!Array.isArray(value)) throw new Error(`${context}.${field} must be an array`);
	return value;
}

function requireStringArray(record: Record<string, unknown>, field: string, context: string): void {
	const values = requireArray(record, field, context);
	if (values.some((value) => typeof value !== "string")) {
		throw new Error(`${context}.${field} must contain only strings`);
	}
}

function validateOptionalStringArray(record: Record<string, unknown>, field: string, context: string): void {
	if (record[field] !== undefined) requireStringArray(record, field, context);
}

function requireEnum(
	record: Record<string, unknown>,
	field: string,
	allowed: readonly string[],
	context: string,
): void {
	const value = requireString(record, field, context);
	if (!allowed.includes(value)) throw new Error(`${context}.${field} must be one of: ${allowed.join(", ")}`);
}

function validateRenderData(type: DiagramType, value: unknown): asserts value is RenderData {
	const data = requireRecord(value, "render data");
	if (type === "sequence") {
		requireStringArray(data, "participants", "sequence");
		for (const [index, item] of requireArray(data, "messages", "sequence").entries()) {
			const message = requireRecord(item, `sequence.messages[${index}]`);
			for (const field of ["from", "to", "label"]) requireString(message, field, `sequence.messages[${index}]`);
			if (message.kind !== undefined) {
				requireEnum(message, "kind", ["sync", "async", "return"], `sequence.messages[${index}]`);
			}
		}
		return;
	}
	if (type === "state") {
		requireStringArray(data, "states", "state");
		if (data.initial !== undefined) requireString(data, "initial", "state");
		for (const [index, item] of requireArray(data, "transitions", "state").entries()) {
			const transition = requireRecord(item, `state.transitions[${index}]`);
			for (const field of ["from", "to"]) requireString(transition, field, `state.transitions[${index}]`);
			if (transition.label !== undefined) requireString(transition, "label", `state.transitions[${index}]`);
		}
		return;
	}
	if (type === "class") {
		for (const [index, item] of requireArray(data, "classes", "class").entries()) {
			const classItem = requireRecord(item, `class.classes[${index}]`);
			requireString(classItem, "name", `class.classes[${index}]`);
			validateOptionalStringArray(classItem, "fields", `class.classes[${index}]`);
			validateOptionalStringArray(classItem, "methods", `class.classes[${index}]`);
		}
		for (const [index, item] of requireArray(data, "relations", "class").entries()) {
			const relation = requireRecord(item, `class.relations[${index}]`);
			for (const field of ["from", "to"]) requireString(relation, field, `class.relations[${index}]`);
			requireEnum(relation, "kind", ["extends", "implements", "composes", "uses"], `class.relations[${index}]`);
		}
		return;
	}
	if (type === "flow") {
		for (const [index, item] of requireArray(data, "nodes", "flow").entries()) {
			const node = requireRecord(item, `flow.nodes[${index}]`);
			for (const field of ["id", "label"]) requireString(node, field, `flow.nodes[${index}]`);
			requireEnum(node, "kind", ["dir", "file"], `flow.nodes[${index}]`);
		}
		for (const [index, item] of requireArray(data, "edges", "flow").entries()) {
			const edge = requireRecord(item, `flow.edges[${index}]`);
			for (const field of ["from", "to", "evidence"]) requireString(edge, field, `flow.edges[${index}]`);
			requireEnum(edge, "kind", ["import"], `flow.edges[${index}]`);
		}
		return;
	}
	for (const [index, item] of requireArray(data, "nodes", "er").entries()) {
		const node = requireRecord(item, `er.nodes[${index}]`);
		for (const field of ["id", "label", "schema"]) requireString(node, field, `er.nodes[${index}]`);
		requireEnum(
			node,
			"source",
			["live", "static-sql", "static-prisma", "static-ef", "static-dbt"],
			`er.nodes[${index}]`,
		);
		for (const [columnIndex, item] of requireArray(node, "columns", `er.nodes[${index}]`).entries()) {
			const column = requireRecord(item, `er.nodes[${index}].columns[${columnIndex}]`);
			for (const field of ["name", "dataType"]) {
				requireString(column, field, `er.nodes[${index}].columns[${columnIndex}]`);
			}
			requireBoolean(column, "nullable", `er.nodes[${index}].columns[${columnIndex}]`);
			for (const field of ["isPrimaryKey", "isForeignKey"]) {
				if (column[field] !== undefined) requireBoolean(column, field, `er.nodes[${index}].columns[${columnIndex}]`);
			}
		}
	}
	for (const [index, item] of requireArray(data, "edges", "er").entries()) {
		const edge = requireRecord(item, `er.edges[${index}]`);
		for (const field of ["from", "to", "fromColumn", "toColumn"]) {
			requireString(edge, field, `er.edges[${index}]`);
		}
		requireEnum(edge, "confidence", ["proven", "inferred"], `er.edges[${index}]`);
	}
}

export async function renderFromData(opts: {
	type: DiagramType;
	data: RenderData;
	outPath?: string;
	html?: boolean;
}): Promise<RenderResult> {
	const payload = buildDiagram(opts.type, opts.data);
	const markdown = renderDiagramMarkdown(payload);
	const outBasePath = opts.outPath ?? agentsPath("architecture", `render-${opts.type}`);
	const persisted = persistArchitecture(payload, markdown, outBasePath);
	const result: RenderResult = {
		type: opts.type,
		outPath: persisted.outPath,
		dataOutPath: persisted.evidenceOutPath,
		payload,
	};
	if (opts.html) result.htmlOutPath = persistHtml(renderHtml([payload], payload.title), outBasePath);
	return result;
}

async function resolveInput(concept: string): Promise<{ candidates: ErdCandidate[] }> {
	if (detectErdInputKind(concept) === "concrete") {
		return {
			candidates: [
				{
					id: concept,
					kind: statSync(concept).isDirectory() ? "dir" : "file",
					score: 1,
					evidence: "existing path",
				},
			],
		};
	}
	return { candidates: await resolveErdFuzzy(concept, defaultErdResolveDeps) };
}

export function createErdSpec(overrides: Partial<ErdDeps> = {}) {
	const deps = { ...defaultDeps, ...overrides };
	return {
		name: "erd",
		description: "Generate architecture maps and render structured Mermaid diagrams.",
		async run(argv: string[]): Promise<number> {
			try {
				if (argv.includes("--help") || argv.includes("-h")) {
					process.stdout.write(USAGE);
					return 0;
				}
				const verb = argv[0];
				if (verb === "resolve") {
					process.stdout.write(`${JSON.stringify(await resolveInput(argv[1] ?? ""), null, 2)}\n`);
					return 0;
				}
				if (verb === "generate") {
					const parsed = parseOptions(argv.slice(1), true);
					if (parsed.type && parsed.type !== "er" && parsed.type !== "flow") {
						throw new Error(`generate --type ${parsed.type} requires described data; use erd render`);
					}
					const result = await generateArchitecture({
						scope: parsed.positionals[0] ?? ".",
						depth: parsed.depth,
						outPath: parsed.out ? stripMarkdownSuffix(parsed.out) : undefined,
						type: parsed.type,
						html: parsed.html,
					});
					if (parsed.html && !Array.isArray(result) && result.htmlOutPath) {
						Object.assign(result, await deps.openHtml(result.htmlOutPath));
					}
					process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
					return 0;
				}
				if (verb === "render") {
					const parsed = parseOptions(argv.slice(1));
					if (!parsed.type) throw new Error("render requires --type");
					if (!parsed.data) throw new Error("render requires --data <file|->");
					const data = JSON.parse(await deps.readData(parsed.data)) as unknown;
					validateRenderData(parsed.type, data);
					const result = await renderFromData({
						type: parsed.type,
						data,
						outPath: parsed.out ? stripOutputSuffix(parsed.out) : undefined,
						html: parsed.html,
					});
					if (result.htmlOutPath) Object.assign(result, await deps.openHtml(result.htmlOutPath));
					process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
					return 0;
				}
				process.stderr.write(`Error: unrecognized subcommand "${verb ?? ""}". ${USAGE}`);
				return 1;
			} catch (error) {
				process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
				return 1;
			}
		},
	};
}

export const erdSpec = createErdSpec();
