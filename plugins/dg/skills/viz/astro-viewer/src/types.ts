// Shared payload/view types for the viz viewer. Components import from here so
// the shapes stay in one place.

export type PhaseStatus = "pending" | "in_progress" | "done" | "partial" | "blocked" | "skipped";

export interface PhaseAgents {
	primary?: string;
	qa?: string[];
}

export interface Phase {
	id: string;
	label: string;
	status: PhaseStatus;
	description?: string;
	dependencies?: string[];
	agents?: PhaseAgents;
}

export type ThreadRole = "user" | "ai";

export interface ThreadEntry {
	role: ThreadRole;
	text: string;
	timestamp?: string;
}

export interface Decision {
	question: string;
	answer: string;
	rationale?: string;
	options?: string[];
	multiple?: boolean;
	thread?: ThreadEntry[];
}

export interface PendingDecision {
	index: number;
	question: string;
	options?: string[];
	multiple?: boolean;
	thread?: ThreadEntry[];
	inDiscussion?: boolean;
}

export interface TocItem {
	id: string;
	label: string;
	icon: string;
}

export interface WaitingItem {
	kind: "decision" | "open_question" | "approval" | "permission" | "recommendation" | "next_steps";
	label: string;
	index: number;
	inDiscussion?: boolean;
	/** Section anchor to link to — defaults to "respond" if absent. */
	anchor?: string;
}

export interface Track {
	id: string;
	status: PhaseStatus;
	progress?: number;
	detail?: string;
	label?: string;
	agent?: string;
}

/** Runtime sentinel so `import { Track }` resolves as a defined value in tests. */
export const Track: unique symbol = Symbol("Track");

export interface Approval {
	prompt?: string;
	required?: boolean;
}

/** Runtime sentinel so `import { Approval }` resolves as a defined value in tests. */
export const Approval: unique symbol = Symbol("Approval");

export interface PrDecisionEntry {
	title: string;
	detail?: string;
	source: "spec" | "review" | "commit";
	/** Commit sha (or URL fragment) tying the decision back to the open PR. */
	ref?: string;
}

export interface PrCommit {
	sha: string;
	subject: string;
}

export interface PrDecisionRequest {
	title: string;
	body: string;
	/** Recap of what shipped, rendered as its own Summary section. */
	summary?: string;
	/** Open PR the Decisions/Commits sections link back to. */
	prUrl?: string;
	/** Decisions made during the work, each rendered with a source badge + PR reference. */
	decisions?: PrDecisionEntry[];
	/** base..head commit trail, rendered as its own Commits section. */
	commits?: PrCommit[];
	reviewSlug?: string;
	reviewVerdict?: string;
	reviewSummary?: string;
}

/** Runtime sentinel so `import { PrDecisionRequest }` resolves as a defined value in tests. */
export const PrDecisionRequest: unique symbol = Symbol("PrDecisionRequest");

export interface PrDecision {
	action: "open" | "draft" | "regenerate";
	body: string;
	guidance?: string;
}

/** Runtime sentinel so `import { PrDecision }` resolves as a defined value in tests. */
export const PrDecision: unique symbol = Symbol("PrDecision");

export interface Permission {
	key: string;
	label: string;
	description: string;
	granted: boolean;
}

/** Runtime sentinel so `import { Permission }` resolves as a defined value in tests. */
export const Permission: unique symbol = Symbol("Permission");

export interface Recommendation {
	text: string;
	/** Long-form reasoning, shown only when the row is expanded. */
	detail?: string;
	flavor: "edit" | "escalate" | "prototype";
	outcome?: "accepted" | "rejected" | "deferred";
}

/** Runtime sentinel so `import { Recommendation }` resolves as a defined value in tests. */
export const Recommendation: unique symbol = Symbol("Recommendation");

export interface Agent {
	name: string;
	recommendations: Recommendation[];
}

/** Runtime sentinel so `import { Agent }` resolves as a defined value in tests. */
export const Agent: unique symbol = Symbol("Agent");

/** Answer union — recommendation triage fields (agent, rec, note are optional on the base union). */
export interface AnswerExtension {
	agent?: number;
	rec?: number;
	note?: string;
}

/** Recommendation triage answer (narrowed from AnswerExtension with required fields). */
export interface RecommendationAnswer extends AnswerExtension {
	type: "recommendation";
	agent: number;
	rec: number;
	answer: "accepted" | "rejected" | "deferred";
}

/** Payload-level flag: true → triage controls visible; absent/false → read-only. */
export interface RoundtableInteractivePayload {
	roundtable_interactive?: boolean;
}

export type LineageNodeType = "source" | "staging" | "intermediate" | "model" | "view" | "dashboard" | "stub";
export type LineageNodeRole = "target" | "upstream" | "downstream";
export type LineageEdgeConfidence = "proven" | "inferred";

export interface LineageNode {
	id: string;
	label: string;
	type: LineageNodeType;
	role: LineageNodeRole;
	columns?: string[];
	sql?: string;
	evidence?: string;
	verified?: boolean;
	collapsed?: number;
}

export interface LineageEdge {
	from: string;
	to: string;
	source: string;
	confidence: LineageEdgeConfidence;
	kind?: "back";
	evidence?: string;
}

export interface LineageGraph {
	nodes: LineageNode[];
	edges: LineageEdge[];
	narrative?: string;
	target?: string;
}

/** Minimal payload interface for boards that carry a lineage graph. */
export interface LineagePayload {
	lineage?: LineageGraph;
	[key: string]: unknown;
}

export type EvidenceType = "db-table" | "db-column" | "file" | "import" | string;

export interface EvidenceRecord {
	type: EvidenceType;
	ref: string;
	detail?: string;
}

/**
 * .md-path record only, retained purely for fixture-contract test parity with
 * erd-graph.ts's MermaidPayload — NOT consumed by any viz-side component since
 * the interactive board moved to Cytoscape.
 */
export interface MermaidPayload {
	diagram: string;
	title?: string;
	caption?: string;
}

/** Mirrors erd-graph.ts's ArchitectureGraph shape (codeNodes, codeEdges, dbNodes, dbEdges, crossLinks, evidence, truncated, generatedAt). */
export interface ArchitectureGraph {
	[key: string]: unknown;
}

export interface ErdPayload {
	graph?: ArchitectureGraph;
	evidence?: EvidenceRecord[];
	scope?: string;
	generatedAt?: string;
	[key: string]: unknown;
}

export type DocTone = "good" | "bad" | "warn" | "muted" | "accent";

export interface DocHeadingBlock {
	type: "heading";
	text: string;
	eyebrow?: string;
	level?: 2 | 3;
}
export interface DocProseBlock {
	type: "prose";
	text: string;
}
export interface DocCalloutBlock {
	type: "callout";
	variant?: "info" | "warning" | "note" | "tip";
	title?: string;
	text: string;
}
export interface DocFormulaBlock {
	type: "formula";
	label?: string;
	numerator?: string;
	denominator?: string;
	expression?: string;
	result?: string;
	note?: string;
}
export interface DocCodeBlock {
	type: "code";
	code: string;
	lang?: string;
	title?: string;
	caption?: string;
}
export interface DocTableCell {
	value: string;
	tone?: DocTone;
}
export interface DocTableBlock {
	type: "table";
	columns: string[];
	rows: (string | DocTableCell)[][];
	caption?: string;
}
export interface DocCompareItem {
	title: string;
	body: string;
	tone?: DocTone;
}
export interface DocCompareBlock {
	type: "compare";
	items: DocCompareItem[];
}

export type DocBlock =
	| DocHeadingBlock
	| DocProseBlock
	| DocCalloutBlock
	| DocFormulaBlock
	| DocCodeBlock
	| DocTableBlock
	| DocCompareBlock;
