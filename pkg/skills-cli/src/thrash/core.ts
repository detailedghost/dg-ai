import path from "node:path";
import {
	NIT_LADDER,
	parseOptionalFlag,
	SPICE_DEFAULT,
	SPICE_MAX,
	SPICE_MIN,
	THRASH_REVIEW_HEADING_PREFIX,
	TIER_EMOJI,
	VERDICT_LIMITS,
	wholeNumber,
} from "@dg/common";
import {
	isFileComment,
	type PostedReview,
	type PostReviewInput,
	type PullRequest,
	type ReviewCommentInput,
	type ReviewSummary,
	type ReviewThread,
	type ReviewVerdict,
} from "../provider/types";
import {
	CLASS_HINT_MIN_PRS,
	THRASH_CLASSES_MARKER_PREFIX,
	THRASH_FINDING_MARKER_PREFIX,
	THRASH_REVIEW_MARKER,
	TIERS,
	type Tier,
} from "./constants";
import { type ReviewPolicy, selectPhase } from "./policy";
import { pickSass } from "./sass";

export { THRASH_REVIEW_MARKER, TIERS, type Tier };

export const TIER_LABEL: Record<Tier, string> = {
	critical: "Critical",
	high: "High",
	medium: "Medium",
	low: "Low",
	nit: "Nit",
};

export { NIT_LADDER, SPICE_DEFAULT, SPICE_MAX, SPICE_MIN, TIER_EMOJI, VERDICT_LIMITS } from "@dg/common";

/** Changed lines per review chunk; a diff above this is split. */
export const LARGE_DIFF_LINES = 3000;

/** Parallel review chunks per run; a larger plan merges neighboring chunks to fit. */
export const MAX_CHUNKS = 8;

const ADDRESS_SEVERITY: Record<Tier, "high" | "medium" | "low"> = {
	critical: "high",
	high: "high",
	medium: "medium",
	low: "low",
	nit: "low",
};

export type Side = "new" | "old";

export interface Finding {
	path: string;
	line: number | null;
	side: Side;
	tier: Tier;
	title: string;
	body: string;
	class?: string;
	otherPlaces?: string[];
	preExisting?: boolean;
	tag?: string;
	kind?: "improvement";
}

export interface AgentOutput {
	changed: string;
	strengths: string[];
	opportunities: string[];
	findings: Finding[];
}

export interface DiffLine {
	kind: "context" | "add" | "del";
	oldLine?: number;
	newLine?: number;
	text: string;
}

export type FileStatus = "modified" | "added" | "deleted" | "renamed" | "binary";

export interface DiffFile {
	path: string;
	oldPath: string;
	status: FileStatus;
	hunkHeaders: string[];
	hunkStarts: number[];
	lines: DiffLine[];
}

export interface DiffStats {
	files: number;
	added: number;
	deleted: number;
	changed: number;
}

export interface Anchor {
	path: string;
	oldPath?: string;
	newLine?: number;
	oldLine?: number;
}

export type DropReason = "duplicate" | "settled" | "below-min-tier" | "nit-ladder" | "max-comments" | "max-improvements";

export interface DroppedFinding {
	finding: Finding;
	reason: DropReason;
}

export interface CompiledComment extends ReviewCommentInput {
	tier: Tier;
	title: string;
	kind?: "improvement";
}

export interface CompileOptions {
	spice: number;
	minTier?: Tier;
	commentOnly: boolean;
	existing: ReviewThread[];
	trigger?: ReviewTrigger;
	heading?: string;
	round?: number;
	policy?: ReviewPolicy;
	maxComments?: number;
	maxEvent?: ReviewVerdict;
	sassSeed?: number;
	/** Login whose threads count as this reviewer's own; unset treats every tier-marked thread as thrash's. */
	reviewer?: string;
	improvements?: boolean;
	maxImprovements?: number;
	reReview?: ReReview;
	cleared?: Cleared;
	headSha?: string;
	classHistory?: Readonly<Record<string, number>>;
}

export interface ReReview {
	sha: string;
	files: number;
	lines: number;
}

export interface Cleared {
	fixed: number;
	sha?: string;
	answered: number;
}

export interface BugClass {
	name: string;
	places: string[];
}

const DEFAULT_RECONSIDER_AFTER = 3;
const DEFAULT_MAX_IMPROVEMENTS = 3;
const IMPROVEMENT_EMOJI = "💡";
const PRE_EXISTING_MARKER = "`Pre-existing`";

export type ReviewTrigger = "daemon" | "action" | "manual";

/** Reads the review origin from THRASH_EXECUTION_CONTEXT; anything unreadable is manual. */
export function reviewTrigger(context: string | undefined): ReviewTrigger {
	try {
		const origin = (JSON.parse(context ?? "") as { origin?: unknown }).origin;
		return origin === "daemon" || origin === "action" ? origin : "manual";
	} catch {
		return "manual";
	}
}

const TRIGGER_LABEL: Record<ReviewTrigger, string> = {
	daemon: "Automatic (daemon)",
	action: "Automatic (GitHub Action)",
	manual: "Manual (CLI)",
};

export interface CompiledReview {
	verdict: ReviewVerdict;
	reason: string;
	spice: number;
	tally: Record<Tier, number>;
	changed: string;
	strengths: string[];
	opportunities: string[];
	comments: CompiledComment[];
	unanchored: Finding[];
	dropped: DroppedFinding[];
	preExisting: Finding[];
	classes: BugClass[];
	improvements?: number;
	trigger: ReviewTrigger;
	heading?: string;
	round?: number;
	phase?: string;
	sass?: string;
	body: string;
}

export function tierRank(tier: Tier): number {
	return TIERS.indexOf(tier);
}

export function isTier(value: unknown): value is Tier {
	return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}

export function parseSpice(raw: string | undefined): number {
	return parseOptionalFlag(wholeNumber(SPICE_MIN, SPICE_MAX), raw, "--spice") ?? SPICE_DEFAULT;
}

export function parseTier(raw: string): Tier {
	const value = raw.toLowerCase();
	if (!isTier(value)) throw new Error(`unknown tier "${raw}" (expected one of ${TIERS.join(", ")})`);
	return value;
}

const QUOTED_PATH = '"(?:[^"\\\\]|\\\\.)*"';
const DIFF_HEADER_RE = new RegExp(`^diff --git (${QUOTED_PATH}|a/.+?) (${QUOTED_PATH}|b/.+)$`);
const GIT_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

function unquoteGitPath(raw: string): string {
	if (!raw.startsWith('"') || !raw.endsWith('"') || raw.length < 2) return raw;
	const bytes: number[] = [];
	const body = raw.slice(1, -1);
	for (let i = 0; i < body.length; i++) {
		const ch = body[i];
		if (ch !== "\\") {
			bytes.push(...new TextEncoder().encode(ch));
			continue;
		}
		const octal = /^[0-7]{1,3}/.exec(body.slice(i + 1))?.[0];
		if (octal) {
			bytes.push(Number.parseInt(octal, 8));
			i += octal.length;
		} else {
			bytes.push(GIT_ESCAPES[body[i + 1]] ?? body.charCodeAt(i + 1));
			i += 1;
		}
	}
	return new TextDecoder().decode(new Uint8Array(bytes));
}
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function stripPathPrefix(raw: string): string {
	const trimmed = unquoteGitPath(raw.replace(/\t.*$/, "").trim());
	if (trimmed === "/dev/null") return trimmed;
	return trimmed.replace(/^[ab]\//, "");
}

function newDiffFile(path: string, oldPath: string): DiffFile {
	return { path, oldPath, status: "modified", hunkHeaders: [], hunkStarts: [], lines: [] };
}

export function parseUnifiedDiff(text: string): DiffFile[] {
	const files: DiffFile[] = [];
	let current: DiffFile | null = null;
	let oldCursor = 0;
	let newCursor = 0;
	let inHunk = false;

	for (const rawLine of text.replace(/\n$/, "").split("\n")) {
		const header = DIFF_HEADER_RE.exec(rawLine);
		if (header) {
			current = newDiffFile(stripPathPrefix(header[2]), stripPathPrefix(header[1]));
			files.push(current);
			inHunk = false;
			continue;
		}
		if (!current) continue;

		if (!inHunk) {
			if (rawLine.startsWith("--- ")) {
				const oldPath = stripPathPrefix(rawLine.slice(4));
				if (oldPath === "/dev/null") current.status = "added";
				else current.oldPath = oldPath;
				continue;
			}
			if (rawLine.startsWith("+++ ")) {
				const newPath = stripPathPrefix(rawLine.slice(4));
				if (newPath === "/dev/null") {
					current.status = "deleted";
					current.path = current.oldPath;
				} else {
					current.path = newPath;
				}
				continue;
			}
			if (rawLine.startsWith("rename from ") || rawLine.startsWith("rename to ")) {
				current.status = "renamed";
				continue;
			}
			if (rawLine.startsWith("Binary files ")) {
				current.status = "binary";
				continue;
			}
		}

		const hunk = HUNK_RE.exec(rawLine);
		if (hunk) {
			inHunk = true;
			oldCursor = Number(hunk[1]);
			newCursor = Number(hunk[3]);
			current.hunkHeaders.push(rawLine);
			current.hunkStarts.push(current.lines.length);
			continue;
		}
		if (!inHunk) continue;

		if (rawLine.startsWith("\\")) continue;
		if (rawLine.startsWith("+")) {
			current.lines.push({ kind: "add", newLine: newCursor, text: rawLine.slice(1) });
			newCursor += 1;
		} else if (rawLine.startsWith("-")) {
			current.lines.push({ kind: "del", oldLine: oldCursor, text: rawLine.slice(1) });
			oldCursor += 1;
		} else if (rawLine.startsWith(" ") || rawLine === "") {
			if (rawLine === "" && current.lines.length === 0) continue;
			current.lines.push({ kind: "context", oldLine: oldCursor, newLine: newCursor, text: rawLine.slice(1) });
			oldCursor += 1;
			newCursor += 1;
		}
	}
	return files;
}

const MARKER: Record<DiffLine["kind"], string> = { context: " ", add: "+", del: "-" };

function citation(side: Side, value: number | undefined): string {
	return `${side}:${value ?? "-"}`;
}

/** Renders each diff line with labeled old and new file line numbers so a reader never has to count from a hunk header. */
export function annotateDiff(files: DiffFile[]): string {
	const out: string[] = [];
	for (const file of files) {
		const rename = file.status === "renamed" ? ` (renamed from ${file.oldPath})` : "";
		out.push(`=== ${file.path} [${file.status}]${rename}`);
		if (file.status === "binary") {
			out.push("    binary file, no text diff");
			continue;
		}
		for (const line of file.lines) {
			out.push(
				`${citation("old", line.oldLine)} ${citation("new", line.newLine)} ${MARKER[line.kind]} ${line.text}`,
			);
		}
		out.push("");
	}
	return out.join("\n");
}

export function diffStats(files: DiffFile[]): DiffStats {
	let added = 0;
	let deleted = 0;
	for (const file of files) {
		for (const line of file.lines) {
			if (line.kind === "add") added += 1;
			else if (line.kind === "del") deleted += 1;
		}
	}
	return { files: files.length, added, deleted, changed: added + deleted };
}

/**
 * Resolve a path stored in a thrash plan.json against the folder that holds the plan.
 * Plans store paths relative to that folder, so a copied scratch folder reads its own files.
 * An absolute path (older plans) is accepted only inside the folder. Anything that escapes it throws.
 */
export function resolvePlanPath(root: string, stored: string): string {
	const base = path.resolve(root);
	const resolved = path.resolve(base, stored);
	const rel = path.relative(base, resolved);
	if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
		throw new Error(
			path.isAbsolute(stored)
				? `plan path ${stored} is outside the plan folder ${base}; the plan predates relative paths or was copied, so run thrash diff again`
				: `plan path ${stored} escapes the plan folder ${base}`,
		);
	}
	return resolved;
}

/** Store a scratch path relative to the plan folder; refuses a path outside it. */
export function relativePlanPath(root: string, absolute: string): string {
	const rel = path.relative(path.resolve(root), path.resolve(absolute));
	resolvePlanPath(root, rel);
	return rel;
}

export interface PlanChunk {
	id: number;
	label: string;
	files: string[];
	changed: number;
}

export interface Coverage {
	chunks: PlanChunk[];
	skipped: string[];
}

export interface DiffChunk extends Omit<PlanChunk, "files"> {
	files: DiffFile[];
}

export interface ChunkPlan {
	chunks: DiffChunk[];
	skipped: string[];
}

type ChunkCategory = "source" | "test" | "docs" | "generated";

const CATEGORY_ORDER: readonly ChunkCategory[] = ["source", "test", "docs", "generated"];

const GENERATED_RE =
	/(^|\/)(node_modules|vendor|dist|build|generated|__generated__|third_party)\/|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock|go\.sum|packages\.lock\.json|\.terraform\.lock\.hcl)$|\.(min\.(js|css)|map|snap|lock)$|\.(g|designer|generated)\.[^/]+$/;
const TEST_RE =
	/(^|\/)(__tests__|tests?|specs?)\/|(^|\/)[^/]*\.Tests?\/|\.(test|spec)\.[^/]+$|Tests?\.cs$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/;
const DOCS_RE = /\.(md|mdx|rst|txt|adoc)$|(^|\/)docs?\//;

function categoryOf(filePath: string): ChunkCategory {
	if (GENERATED_RE.test(filePath)) return "generated";
	if (TEST_RE.test(filePath)) return "test";
	if (DOCS_RE.test(filePath)) return "docs";
	return "source";
}

function countChanged(lines: DiffLine[]): number {
	return lines.filter((l) => l.kind !== "context").length;
}

function fileChanged(file: DiffFile): number {
	return countChanged(file.lines);
}

function sumChanged(files: DiffFile[]): number {
	return files.reduce((total, f) => total + fileChanged(f), 0);
}

function cutSegment(segment: DiffLine[], limit: number): DiffLine[][] {
	const pieces: DiffLine[][] = [];
	let current: DiffLine[] = [];
	let weight = 0;
	for (const line of segment) {
		const cost = line.kind === "context" ? 0 : 1;
		if (weight + cost > limit) {
			pieces.push(current);
			current = [];
			weight = 0;
		}
		current.push(line);
		weight += cost;
	}
	if (current.length > 0) pieces.push(current);
	return pieces;
}

function splitFileByHunks(file: DiffFile, limit: number): DiffFile[] {
	const starts = file.hunkStarts.length > 0 ? file.hunkStarts : [0];
	const segments = starts.map((start, i) => file.lines.slice(start, starts[i + 1]));
	const pieces = segments.flatMap((segment) =>
		countChanged(segment) > limit ? cutSegment(segment, limit) : [segment],
	);
	const parts: DiffLine[][] = [];
	let current: DiffLine[] = [];
	let weight = 0;
	for (const piece of pieces) {
		const cost = countChanged(piece);
		if (current.length > 0 && weight + cost > limit) {
			parts.push(current);
			current = [];
			weight = 0;
		}
		current.push(...piece);
		weight += cost;
	}
	if (current.length > 0) parts.push(current);
	return parts.map((lines) => ({ ...file, hunkHeaders: [], hunkStarts: [], lines }));
}

function directoryAt(filePath: string, depth: number): string | null {
	const parts = filePath.split("/");
	return parts.length - 1 > depth ? parts[depth] : null;
}

function groupUnits(files: DiffFile[], limit: number, depth = 0): DiffFile[][] {
	if (sumChanged(files) <= limit) return [files];
	const groups = new Map<string | null, DiffFile[]>();
	for (const file of files) {
		const key = directoryAt(file.path, depth);
		groups.set(key, [...(groups.get(key) ?? []), file]);
	}
	const units: DiffFile[][] = [];
	for (const [key, group] of groups) {
		if (key === null) units.push(...group.map((f) => [f]));
		else units.push(...groupUnits(group, limit, depth + 1));
	}
	return units;
}

function packUnits(units: DiffFile[][], limit: number): DiffFile[][] {
	const chunks: DiffFile[][] = [];
	let current: DiffFile[] = [];
	let weight = 0;
	for (const unit of units) {
		const cost = sumChanged(unit);
		if (current.length > 0 && weight + cost > limit) {
			chunks.push(current);
			current = [];
			weight = 0;
		}
		current.push(...unit);
		weight += cost;
	}
	if (current.length > 0) chunks.push(current);
	return chunks;
}

function commonDirectory(files: DiffFile[]): string {
	const dirs = files.map((f) => f.path.split("/").slice(0, -1));
	const first = dirs[0] ?? [];
	let shared = first.length;
	for (const dir of dirs) {
		let i = 0;
		while (i < shared && dir[i] === first[i]) i += 1;
		shared = i;
	}
	return first.slice(0, shared).join("/") || ".";
}

function byPath(a: DiffFile, b: DiffFile): number {
	if (a.path === b.path) return 0;
	return a.path < b.path ? -1 : 1;
}

function splitIntoChunks(files: DiffFile[], limit: number): DiffFile[][] {
	const units = groupUnits(files, limit).flatMap((unit) =>
		unit.length === 1 && fileChanged(unit[0]) > limit ? splitFileByHunks(unit[0], limit).map((part) => [part]) : [unit],
	);
	return packUnits(units, limit);
}

function mergeNeighbors(groups: Array<{ category: ChunkCategory; files: DiffFile[] }>, cap: number) {
	const merged = [...groups];
	while (merged.length > cap) {
		let best = 0;
		let bestKey: [number, number] = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
		for (let i = 0; i < merged.length - 1; i++) {
			const key: [number, number] = [
				merged[i].category === merged[i + 1].category ? 0 : 1,
				sumChanged(merged[i].files) + sumChanged(merged[i + 1].files),
			];
			if (key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) {
				best = i;
				bestKey = key;
			}
		}
		const [left, right] = [merged[best], merged[best + 1]];
		merged.splice(best, 2, { category: left.category, files: [...left.files, ...right.files] });
	}
	return merged;
}

/** Splits a diff into chunks of at most `limit` changed lines, source first, merging neighbors to fit `cap`. */
export function planChunks(files: DiffFile[], limit = LARGE_DIFF_LINES, cap = MAX_CHUNKS): ChunkPlan {
	if (files.length === 0) return { chunks: [], skipped: [] };
	if (sumChanged(files) <= limit) {
		return { chunks: [{ id: 1, label: "whole diff", files, changed: sumChanged(files) }], skipped: [] };
	}
	const sorted = [...files].sort(byPath);
	const skipped: string[] = [];
	const ordered: Array<{ category: ChunkCategory; files: DiffFile[] }> = [];
	for (const category of CATEGORY_ORDER) {
		const members = sorted.filter((f) => categoryOf(f.path) === category);
		let groups: DiffFile[][];
		if (category === "generated") {
			const kept: DiffFile[] = [];
			let weight = 0;
			for (const file of members) {
				const cost = fileChanged(file);
				if (weight + cost > limit) skipped.push(file.path);
				else {
					kept.push(file);
					weight += cost;
				}
			}
			groups = kept.length > 0 ? [kept] : [];
		} else {
			groups = splitIntoChunks(members, limit);
		}
		for (const group of groups) ordered.push({ category, files: group });
	}
	const chunks = mergeNeighbors(ordered, cap).map(({ files: group }, i) => {
		const categories = new Set(group.map((f) => categoryOf(f.path)));
		const label = categories.size === 1 ? [...categories][0] : "mixed";
		return { id: i + 1, label: `${label}: ${commonDirectory(group)}`, files: group, changed: sumChanged(group) };
	});
	return { chunks, skipped };
}

export function chunkSummary(chunk: DiffChunk): PlanChunk {
	return { ...chunk, files: [...new Set(chunk.files.map((f) => f.path))] };
}

function normalizeBody(body: string): string {
	return body.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Joins chunk outputs into one, dropping a finding another chunk already reported on the same path, line, side, and body. */
export function mergeOutputs(outputs: AgentOutput[]): AgentOutput {
	const seen = new Map<string, Finding>();
	for (const output of outputs) {
		for (const finding of output.findings) {
			const key = [finding.path, finding.line, finding.side, normalizeBody(finding.body)].join("\u0000");
			const kept = seen.get(key);
			if (!kept || tierRank(finding.tier) < tierRank(kept.tier)) seen.set(key, finding);
		}
	}
	const changes = outputs.map((o, i) => (o.changed ? `Chunk ${i + 1}: ${o.changed}` : ""));
	return {
		changed: outputs.length === 1 ? outputs[0].changed : changes.filter(Boolean).join(" "),
		strengths: uniqueItems(outputs.flatMap((o) => o.strengths)),
		opportunities: uniqueItems(outputs.flatMap((o) => o.opportunities)),
		findings: [...seen.values()],
	};
}

function uniqueItems(items: string[]): string[] {
	const seen = new Map<string, string>();
	for (const item of items) if (!seen.has(normalizeBody(item))) seen.set(normalizeBody(item), item);
	return [...seen.values()];
}

function findFile(files: DiffFile[], finding: Finding): DiffFile | undefined {
	return files.find((f) => f.path === finding.path) ?? files.find((f) => f.oldPath === finding.path);
}

/** Maps a finding onto a line the diff actually contains, or null when no such line exists on that side. */
export function resolveAnchor(files: DiffFile[], finding: Finding): Anchor | null {
	if (finding.line === null) return null;
	const file = findFile(files, finding);
	if (!file || file.status === "binary") return null;
	const oldPath = file.oldPath !== file.path ? file.oldPath : undefined;
	if (finding.side === "old") {
		const hit = file.lines.find((l) => l.oldLine === finding.line && l.kind !== "add");
		if (!hit) return null;
		return { path: file.path, oldPath, oldLine: hit.oldLine, newLine: hit.newLine };
	}
	const hit = file.lines.find((l) => l.newLine === finding.line && l.kind !== "del");
	if (!hit) return null;
	return { path: file.path, oldPath, newLine: hit.newLine, oldLine: hit.oldLine };
}

/** Maps a finding with no usable line onto its whole file, or null when the diff does not contain that file. */
export function resolveFileAnchor(files: DiffFile[], finding: Finding): Anchor | null {
	const file = findFile(files, finding);
	if (!file || file.status === "binary") return null;
	return { path: file.path, oldPath: file.oldPath !== file.path ? file.oldPath : undefined };
}

const FENCED_JSON_RE = /```(?:json)?\s*\n([\s\S]*?)\n```/g;

function extractJsonText(text: string): string {
	const blocks = [...text.matchAll(FENCED_JSON_RE)].map((m) => m[1]);
	if (blocks.length > 0) return blocks[blocks.length - 1];
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end <= start) throw new Error("agent output contains no JSON object");
	return text.slice(start, end + 1);
}

const TIER_ALIASES: Record<string, Tier> = {
	crit: "critical",
	blocker: "critical",
	med: "medium",
	minor: "low",
	nitpick: "nit",
	nits: "nit",
	nitpicky: "nit",
};

function coerceTier(raw: unknown, index: number): Tier {
	const value = String(raw ?? "").toLowerCase();
	if (isTier(value)) return value;
	const alias = TIER_ALIASES[value];
	if (alias) return alias;
	throw new Error(`finding ${index}: unknown tier "${String(raw)}"`);
}

function coerceLine(raw: unknown, index: number): number | null {
	if (raw === null || raw === undefined) return null;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1)
		throw new Error(`finding ${index}: line must be a positive integer or null`);
	return value;
}

export function parseAgentOutput(text: string): AgentOutput {
	const parsed = JSON.parse(extractJsonText(text));
	if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.findings)) {
		throw new Error('agent output must be an object with a "findings" array');
	}
	const findings: Finding[] = parsed.findings.map((raw: Record<string, unknown>, index: number) => {
		const path = typeof raw.path === "string" ? raw.path.trim() : "";
		const body = typeof raw.body === "string" ? raw.body.trim() : "";
		if (!body) throw new Error(`finding ${index}: body is required`);
		const improvement = raw.kind === "improvement";
		return {
			path,
			line: coerceLine(raw.line, index),
			side: raw.side === "old" ? "old" : "new",
			tier: improvement && raw.tier === undefined ? "nit" : coerceTier(raw.tier, index),
			title: typeof raw.title === "string" ? raw.title.trim() : "",
			body,
			...optionalFields(raw, improvement),
		};
	});
	return {
		changed: typeof parsed.changed === "string" ? parsed.changed.trim() : "",
		strengths: stringList(parsed.strengths),
		opportunities: stringList(parsed.opportunities),
		findings,
	};
}

function optionalFields(raw: Record<string, unknown>, improvement: boolean): Partial<Finding> {
	const bugClass = typeof raw.class === "string" ? raw.class.trim() : "";
	const tag = typeof raw.tag === "string" ? raw.tag.trim() : "";
	const otherPlaces = stringList(raw.otherPlaces);
	return {
		...(bugClass && { class: bugClass }),
		...(bugClass && otherPlaces.length > 0 && { otherPlaces }),
		...(raw.preExisting === true && { preExisting: true }),
		...(tag && { tag }),
		...(improvement && { kind: "improvement" as const }),
	};
}

function stringList(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	return raw.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim());
}

export function emptyTally(): Record<Tier, number> {
	return { critical: 0, high: 0, medium: 0, low: 0, nit: 0 };
}

export function tallyFindings(findings: Finding[]): Record<Tier, number> {
	const tally = emptyTally();
	for (const f of findings) tally[f.tier] += 1;
	return tally;
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

type Verdict = { verdict: ReviewVerdict; reason: string };

function verdictWithin(
	tally: Record<Tier, number>,
	limits: Partial<Record<Tier, number>>,
	commentOnly: boolean,
	scope: string,
): Verdict {
	const counts = `${plural(tally.critical, "critical")}, ${plural(tally.high, "high")}`;
	if (commentOnly) return { verdict: "comment", reason: `comment only requested (${counts})` };
	for (const tier of TIERS) {
		const limit = limits[tier];
		if (limit === undefined || tally[tier] <= limit) continue;
		const open = `${plural(tally[tier], `${tier} finding`)} ${tally[tier] === 1 ? "is" : "are"} open`;
		return {
			verdict: "request_changes",
			reason: limit === 0 ? open : `${open}, limit is ${limit} ${scope}`,
		};
	}
	return { verdict: "approve", reason: counts };
}

export function decideVerdict(tally: Record<Tier, number>, spice: number, commentOnly: boolean): Verdict {
	return verdictWithin(tally, VERDICT_LIMITS[spice] ?? VERDICT_LIMITS[SPICE_DEFAULT], commentOnly, `at spice ${spice}`);
}

const ALLOWED_EVENTS: Record<ReviewVerdict, readonly ReviewVerdict[]> = {
	approve: ["approve", "comment"],
	request_changes: ["request_changes", "comment"],
	comment: ["comment"],
};

/** Posts a verdict the caller's highest allowed event does not cover as a comment, and says why. */
export function capVerdict(decided: Verdict, maxEvent: ReviewVerdict | undefined): Verdict {
	if (maxEvent === undefined || ALLOWED_EVENTS[maxEvent].includes(decided.verdict)) return decided;
	return {
		verdict: "comment",
		reason: `${decided.reason}; ${verdictLabel(decided.verdict).toLowerCase()} is turned off, so this posts as a comment`,
	};
}

export function renderComment(finding: Finding): string {
	const tag = finding.tag ? ` \`${finding.tag}\`` : "";
	if (finding.kind === "improvement") {
		return `${IMPROVEMENT_EMOJI} **Improvement**${tag} ${finding.body}\n\nOptional. This does not count toward the verdict, and you do not need to reply.`;
	}
	const preExisting = finding.preExisting ? ` ${PRE_EXISTING_MARKER}` : "";
	const note = finding.preExisting ? " This PR did not add it, and it does not block." : "";
	const sameClass = finding.otherPlaces?.length
		? `\n\nSame class (${finding.class}) at: ${finding.otherPlaces.join(", ")}`
		: "";
	return `${TIER_EMOJI[finding.tier]} **${TIER_LABEL[finding.tier]}**${tag}${preExisting} ${finding.body}${note}${sameClass}`;
}

/** The posted inline body: the comment plus a hidden key a later round reads back to see if the finding returned. */
export function renderInlineBody(finding: Finding): string {
	const key = findingKey(finding);
	return key ? `${renderComment(finding)}\n\n${THRASH_FINDING_MARKER_PREFIX}${JSON.stringify(key)} -->` : renderComment(finding);
}

/** The class key when a class is set, else the title key; empty when the finding names neither. */
function findingKey(finding: Finding): string {
	return classKey(finding.class ?? "") || classKey(finding.title);
}

function threadKey(thread: ReviewThread): string | undefined {
	const body = thread.comments[0]?.body ?? "";
	const start = body.indexOf(THRASH_FINDING_MARKER_PREFIX);
	if (start === -1) return undefined;
	const end = body.indexOf(" -->", start);
	try {
		const key: unknown = JSON.parse(body.slice(start + THRASH_FINDING_MARKER_PREFIX.length, end));
		return typeof key === "string" ? key : undefined;
	} catch {
		return undefined;
	}
}

/** Same file, and the same class or title key. A thread with no key cannot be judged, so it never matches. */
function isSameFinding(thread: ReviewThread, finding: Finding): boolean {
	const key = threadKey(thread);
	return key !== undefined && thread.path === finding.path && key === findingKey(finding);
}

const THRASH_MARKERS = Object.values(TIER_EMOJI);

function sameLogin(a: string, b: string): boolean {
	const norm = (login: string) => login.trim().toLowerCase().replace(/\[bot\]$/, "");
	return norm(a) === norm(b);
}

function threadTier(thread: ReviewThread): Tier | undefined {
	const first = thread.comments[0]?.body ?? "";
	if (first.includes(PRE_EXISTING_MARKER)) return undefined;
	return TIERS.find((tier) => first.startsWith(TIER_EMOJI[tier]));
}

function isThrashThread(thread: ReviewThread, reviewer?: string, markers: readonly string[] = THRASH_MARKERS): boolean {
	const first = thread.comments[0];
	if (!first || (reviewer !== undefined && !sameLogin(first.author, reviewer))) return false;
	return markers.some((m) => first.body.startsWith(m));
}

/** Someone other than the thread's opener replied in it. */
export function isAnswered(thread: ReviewThread): boolean {
	const opener = thread.comments[0]?.author ?? "";
	return thread.comments.slice(1).some((c) => !sameLogin(c.author, opener));
}

function isOutdatedThread(thread: ReviewThread): boolean {
	return thread.outdated ?? (thread.line === null && thread.originalLine != null);
}

function anchorSide(anchor: Anchor): "LEFT" | "RIGHT" {
	return anchor.newLine === undefined ? "LEFT" : "RIGHT";
}

function threadAtAnchor(thread: ReviewThread, anchor: Anchor): boolean {
	const line = anchor.newLine ?? anchor.oldLine ?? null;
	return (
		!isOutdatedThread(thread) &&
		thread.path === anchor.path &&
		thread.line === line &&
		(thread.side === undefined || thread.side === anchorSide(anchor))
	);
}

function priorThreadAt(anchor: Anchor, existing: ReviewThread[], reviewer?: string): "unresolved" | "resolved" | null {
	const prior = existing.filter((t) => threadAtAnchor(t, anchor) && isThrashThread(t, reviewer));
	if (prior.some((t) => !t.resolved)) return "unresolved";
	return prior.length > 0 ? "resolved" : null;
}

function improvementThreadAt(anchor: Anchor, existing: ReviewThread[], reviewer?: string): boolean {
	return existing.some((t) => threadAtAnchor(t, anchor) && isThrashThread(t, reviewer, [IMPROVEMENT_EMOJI]));
}

/** Tiers of this reviewer's earlier findings that are neither resolved nor answered. */
export function openPriorTally(existing: ReviewThread[], reviewer?: string): Record<Tier, number> {
	const tally = emptyTally();
	for (const thread of existing) {
		const tier = threadTier(thread);
		if (tier && !thread.resolved && !isAnswered(thread) && isThrashThread(thread, reviewer)) tally[tier] += 1;
	}
	return tally;
}

function sortKey(f: Finding): string {
	return `${f.path}\u0000${String(f.line ?? 0).padStart(8, "0")}`;
}

function ordinal(a: string, b: string): number {
	if (a === b) return 0;
	return a < b ? -1 : 1;
}

/** Peppers for the spice level, hollow circles for the levels above it. */
export function spiceLabel(spice: number): string {
	return "🌶️".repeat(spice) + "○".repeat(SPICE_MAX - spice);
}

function titled(text: string, title: string): string {
	return `<span title="${title}">${text}</span>`;
}

function tableCell(text: string): string {
	return text.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
}

interface AlertSection {
	heading: string;
	items: string[];
}

function renderAlert(kind: string, sections: AlertSection[]): string[] {
	const filled = sections.filter((section) => section.items.length > 0);
	if (filled.length === 0) return [];
	const body = filled.flatMap(({ heading, items }, i) => [
		...(i > 0 ? [">"] : []),
		`> **${heading}**`,
		">",
		...items.map((item) => `> - ${item}`),
	]);
	return [`> [!${kind}]`, ...body, ""];
}

function verdictLabel(verdict: ReviewVerdict): string {
	if (verdict === "approve") return "Approve";
	if (verdict === "request_changes") return "Request changes";
	return "Comment";
}

function commentCounts(comments: CompiledComment[]): string {
	const files = comments.filter(isFileComment).length;
	return `${plural(comments.length - files, "line comment")}, ${plural(files, "file comment")}`;
}

export function classKey(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function placeOf(finding: Finding): string {
	return finding.line === null ? finding.path : `${finding.path}:${finding.line}`;
}

function groupClasses(findings: Finding[]): BugClass[] {
	const groups = new Map<string, BugClass>();
	for (const finding of findings) {
		const key = classKey(finding.class ?? "");
		if (!key) continue;
		const group = groups.get(key) ?? { name: finding.class as string, places: [] };
		for (const place of [placeOf(finding), ...(finding.otherPlaces ?? [])]) {
			if (!group.places.includes(place)) group.places.push(place);
		}
		groups.set(key, group);
	}
	return [...groups.values()];
}

function classNote({ name, places }: BugClass): string {
	const label = name.charAt(0).toUpperCase() + name.slice(1);
	return `${label} in ${plural(places.length, "place")}: ${places.map((place) => `\`${place}\``).join(", ")}`;
}

function shortSha(sha: string): string {
	return sha.slice(0, 7);
}

function clearedText({ fixed, sha, answered }: Cleared): string {
	const parts = [
		...(fixed > 0 ? [`${fixed} fixed${sha ? ` in \`${shortSha(sha)}\`` : ""}`] : []),
		...(answered > 0 ? [`${answered} answered`] : []),
	];
	return parts.length > 0 ? `${parts.join(", ")}.` : "";
}

interface BodySlots {
	reconsider: boolean;
	reReview?: ReReview;
	cleared?: Cleared;
	hints: Array<{ name: string; text: string }>;
}

function renderBody(review: Omit<CompiledReview, "body">, slots: BodySlots): string {
	const folded = review.dropped.filter((d) => d.reason === "nit-ladder");
	const duplicates = review.dropped.filter((d) => d.reason === "duplicate").length;
	const settled = review.dropped.filter((d) => d.reason === "settled").length;
	const overCap = review.dropped.filter((d) => d.reason === "max-comments");
	const counts = TIERS.map((t) => {
		const count = t === "nit" && folded.length > 0 ? `${review.tally.nit} (${folded.length} folded)` : review.tally[t];
		return `${titled(TIER_EMOJI[t], TIER_LABEL[t])} ${count}`;
	});
	const suggestions =
		review.improvements === undefined ? [] : [`${titled(IMPROVEMENT_EMOJI, "Improvement")} ${review.improvements}`];
	const spice = titled(spiceLabel(review.spice), `Spice ${review.spice} of ${SPICE_MAX}`);
	const round =
		review.round === undefined ? [] : [`**Round:** ${review.round}${review.phase ? `, ${review.phase}` : ""}`];
	const cleared = slots.cleared ? clearedText(slots.cleared) : "";
	const lines: string[] = [
		review.heading ? `## ${review.heading}` : `${THRASH_REVIEW_HEADING_PREFIX}${spice}`,
		"",
		[
			...counts,
			...suggestions,
			...round,
			`**Verdict:** ${verdictLabel(review.verdict)}. ${review.reason}.`,
			commentCounts(review.comments),
		].join(" · "),
		...(review.sass ? ["", `_${review.sass}_`] : []),
		"",
		...(slots.reconsider
			? renderAlert("IMPORTANT", [
					{
						heading: `Round ${review.round}, and a blocker is still open.`,
						items: ["Try a new approach, or ask a person to review."],
					},
				])
			: []),
		...renderAlert("NOTE", [
			{ heading: "What changed", items: review.changed ? [review.changed] : [] },
			{
				heading: "Re-review",
				items: slots.reReview
					? [
							`Only the diff since \`${shortSha(slots.reReview.sha)}\`: ${plural(slots.reReview.files, "file")}, ${plural(slots.reReview.lines, "line")}.`,
						]
					: [],
			},
		]),
		...renderAlert("TIP", [{ heading: "Strengths", items: review.strengths }]),
		...renderAlert("WARNING", [
			{
				heading: "Opportunities",
				items: [...review.opportunities, ...review.classes.filter((c) => c.places.length > 1).map(classNote)],
			},
		]),
	];
	const bullets = [
		...(cleared ? [`- **Cleared:** ${cleared}`] : []),
		...slots.hints.map(({ name, text }) => `- **${name.charAt(0).toUpperCase()}${name.slice(1)}:** ${text}`),
		...(review.preExisting.length > 0
			? [
					`- **Pre-existing:** ${review.preExisting.length}, not counted.`,
					...review.preExisting.map(
						(finding) => `  - ${TIER_EMOJI[finding.tier]} \`${placeOf(finding)}\` ${finding.title}`,
					),
				]
			: []),
	];
	if (bullets.length > 0) lines.push(...bullets, "");
	lines.push(`**Trigger:** ${TRIGGER_LABEL[review.trigger]}`);
	if (duplicates > 0) {
		lines.push("", `${plural(duplicates, "finding")} already flagged on an open thread and not reposted.`);
	}
	if (settled > 0) {
		lines.push("", `${plural(settled, "finding")} on a line with a resolved thread and not reposted.`);
	}
	if (overCap.length > 0) {
		lines.push("", `${plural(overCap.length, "finding")} over the comment cap and not posted inline:`);
		for (const { finding } of overCap) {
			const where = finding.line === null ? finding.path : `${finding.path}:${finding.line}`;
			lines.push(`- ${TIER_EMOJI[finding.tier]} **${TIER_LABEL[finding.tier]}** \`${where}\` ${finding.title}`);
		}
	}
	if (review.unanchored.length > 0) {
		const count = review.unanchored.length;
		lines.push("", `${plural(count, "finding")} named no file in this diff and ${count === 1 ? "was" : "were"} not posted:`);
		for (const finding of review.unanchored) {
			lines.push(`- ${TIER_EMOJI[finding.tier]} ${finding.title}`);
		}
	}
	if (review.classes.length > 0) {
		lines.push("", `${THRASH_CLASSES_MARKER_PREFIX}${JSON.stringify(review.classes.map((c) => classKey(c.name)))} -->`);
	}
	lines.push("", THRASH_REVIEW_MARKER);
	return lines.join("\n");
}

interface Reconciled {
	tally: Record<Tier, number>;
	fixed: number;
}

function reconcileThreads(files: DiffFile[], findings: Finding[], opts: CompileOptions): Reconciled {
	const tally = openPriorTally(opts.existing, opts.reviewer);
	const unmatched = opts.existing.flatMap((thread) => {
		const tier = threadTier(thread);
		return tier && !thread.resolved && !isAnswered(thread) && isThrashThread(thread, opts.reviewer)
			? [{ thread, tier }] : [];
	}).sort((a, b) => tierRank(a.tier) - tierRank(b.tier));
	const consume = (index: number, finding: Finding) => {
		const [{ tier }] = unmatched.splice(index, 1);
		if (tierRank(finding.tier) < tierRank(tier)) {
			tally[tier] -= 1;
			tally[finding.tier] += 1;
		}
	};
	for (const finding of [...findings].sort((a, b) => tierRank(a.tier) - tierRank(b.tier))) {
		const anchor = resolveAnchor(files, finding) ?? resolveFileAnchor(files, finding);
		const index = anchor ? unmatched.findIndex(({ thread }) => threadAtAnchor(thread, anchor)) : -1;
		const moved = unmatched.findIndex(({ thread }) => isOutdatedThread(thread) && isSameFinding(thread, finding));
		if (index !== -1) {
			consume(index, finding);
		} else if (moved !== -1) {
			consume(moved, finding);
		} else if (!anchor || priorThreadAt(anchor, opts.existing, opts.reviewer) !== "resolved" || tierRank(finding.tier) <= tierRank("high")) {
			tally[finding.tier] += 1;
		}
	}
	let fixed = 0;
	for (const { thread, tier } of unmatched) {
		if (!isOutdatedThread(thread) || threadKey(thread) === undefined) continue;
		tally[tier] -= 1;
		fixed += 1;
	}
	return { tally, fixed };
}

function answeredThreads(existing: ReviewThread[], reviewer?: string): number {
	return existing.filter(
		(thread) => threadTier(thread) && !thread.resolved && isAnswered(thread) && isThrashThread(thread, reviewer),
	).length;
}

const classHint = (count: number) =>
	`This class came up in ${count} recent PRs. Consider a rule in docs/code_review.md or a lint check.`;

function isThrashReview(review: ReviewSummary, reviewer?: string): boolean {
	return (
		review.state !== "PENDING" &&
		review.body.includes(THRASH_REVIEW_MARKER) &&
		(reviewer === undefined || sameLogin(review.author, reviewer))
	);
}

/** Commit of the latest submitted thrash review, so the next round can review only what came after it. */
export function lastReviewedSha(reviews: ReviewSummary[], reviewer?: string): string | undefined {
	return reviews.filter((r) => isThrashReview(r, reviewer) && r.commitId).at(-1)?.commitId;
}

/** Class keys written into a review body by the hidden class marker; empty when absent or unreadable. */
export function parseClassMarker(body: string): string[] {
	const start = body.indexOf(THRASH_CLASSES_MARKER_PREFIX);
	if (start === -1) return [];
	const end = body.indexOf(" -->", start);
	try {
		const names: unknown = JSON.parse(body.slice(start + THRASH_CLASSES_MARKER_PREFIX.length, end));
		return Array.isArray(names) ? names.filter((name): name is string => typeof name === "string") : [];
	} catch {
		return [];
	}
}

/** For each class key, how many of the given PRs have a thrash review that names it. */
export function classPrCounts(reviewsByPr: ReviewSummary[][], reviewer?: string): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const reviews of reviewsByPr) {
		const keys = new Set(reviews.filter((r) => isThrashReview(r, reviewer)).flatMap((r) => parseClassMarker(r.body)));
		for (const key of keys) counts[key] = (counts[key] ?? 0) + 1;
	}
	return counts;
}

export function compileReview(files: DiffFile[], output: AgentOutput, opts: CompileOptions): CompiledReview {
	const sorted = [...output.findings].sort((a, b) => ordinal(sortKey(a), sortKey(b)));
	const findings = sorted.filter((f) => f.kind !== "improvement");
	const improvementsOn = opts.improvements ?? opts.policy?.improvements ?? false;
	const suggestions = improvementsOn ? sorted.filter((f) => f.kind === "improvement") : [];
	const maxImprovements = opts.maxImprovements ?? opts.policy?.maxImprovements ?? DEFAULT_MAX_IMPROVEMENTS;
	const openPrior = opts.policy ? openPriorTally(opts.existing, opts.reviewer) : emptyTally();
	const phase = opts.policy ? selectPhase(opts.policy, opts.round ?? 1, openPrior) : undefined;
	const phaseFloor: Tier | undefined = phase && !phase.nits ? "low" : undefined;
	const minTier =
		opts.minTier !== undefined && phaseFloor !== undefined && tierRank(opts.minTier) > tierRank(phaseFloor)
			? phaseFloor
			: (opts.minTier ?? phaseFloor);
	const maxComments = opts.maxComments ?? opts.policy?.maxComments;

	const posted: Array<{ finding: Finding; comment: CompiledComment }> = [];
	const unanchored: Finding[] = [];
	const dropped: DroppedFinding[] = [];
	const nitCap = minTier === undefined ? (NIT_LADDER[opts.spice] ?? 0) : Number.POSITIVE_INFINITY;
	let nitsKept = 0;

	for (const finding of findings) {
		if (minTier !== undefined && tierRank(finding.tier) > tierRank(minTier)) {
			dropped.push({ finding, reason: "below-min-tier" });
			continue;
		}
		if (finding.tier === "nit" && nitsKept >= nitCap) {
			dropped.push({ finding, reason: "nit-ladder" });
			continue;
		}
		const anchor = resolveAnchor(files, finding) ?? resolveFileAnchor(files, finding);
		if (!anchor) {
			unanchored.push(finding);
			continue;
		}
		const prior = priorThreadAt(anchor, opts.existing, opts.reviewer);
		if (prior === "unresolved") {
			dropped.push({ finding, reason: "duplicate" });
			continue;
		}
		if (prior === "resolved" && tierRank(finding.tier) > tierRank("high")) {
			dropped.push({ finding, reason: "settled" });
			continue;
		}
		if (finding.tier === "nit") nitsKept += 1;
		posted.push({
			finding,
			comment: { ...anchor, tier: finding.tier, title: finding.title, body: renderInlineBody(finding) },
		});
	}

	let kept = posted;
	if (maxComments !== undefined && posted.length > maxComments) {
		const ranked = [...posted].sort((a, b) => tierRank(a.finding.tier) - tierRank(b.finding.tier));
		const keep = new Set(ranked.slice(0, maxComments));
		kept = posted.filter((p) => keep.has(p));
		for (const p of posted) if (!keep.has(p)) dropped.push({ finding: p.finding, reason: "max-comments" });
	}
	const suggestionComments: CompiledComment[] = [];
	for (const finding of suggestions) {
		const anchor = resolveAnchor(files, finding) ?? resolveFileAnchor(files, finding);
		if (!anchor || improvementThreadAt(anchor, opts.existing, opts.reviewer)) continue;
		if (suggestionComments.length >= maxImprovements) {
			dropped.push({ finding, reason: "max-improvements" });
			continue;
		}
		suggestionComments.push({
			...anchor,
			tier: finding.tier,
			title: finding.title,
			kind: "improvement",
			body: renderComment(finding),
		});
	}
	const counted = findings.filter((f) => !f.preExisting);
	const reconciled = reconcileThreads(files, counted, opts);
	const tally = phase ? reconciled.tally : tallyFindings(counted);
	const decided = phase
		? verdictWithin(tally, phase.block, opts.commentOnly, phase.name ? `in a ${phase.name} round` : "by policy")
		: decideVerdict(tally, opts.spice, opts.commentOnly);
	const { verdict, reason } = capVerdict(decided, opts.maxEvent);

	const compiled = {
		verdict,
		reason,
		spice: opts.spice,
		tally,
		changed: output.changed,
		strengths: output.strengths,
		opportunities: output.opportunities,
		comments: [...kept.map((p) => p.comment), ...suggestionComments],
		unanchored,
		dropped,
		preExisting: kept.filter((p) => p.finding.preExisting).map((p) => p.finding),
		classes: groupClasses(kept.filter((p) => !p.finding.preExisting).map((p) => p.finding)),
		improvements: improvementsOn ? suggestionComments.length : undefined,
		trigger: opts.trigger ?? "manual",
		heading: opts.heading,
		round: opts.round,
		phase: phase?.name || undefined,
		sass: opts.sassSeed === undefined ? undefined : pickSass(verdict, tally, opts.sassSeed),
	};
	const answered = answeredThreads(opts.existing, opts.reviewer);
	const cleared =
		opts.cleared ?? (reconciled.fixed + answered > 0 ? { fixed: reconciled.fixed, sha: opts.headSha, answered } : undefined);
	const hints = compiled.classes.flatMap(({ name }) => {
		const count = opts.classHistory?.[classKey(name)] ?? 0;
		return count >= CLASS_HINT_MIN_PRS ? [{ name, text: classHint(count) }] : [];
	});
	const reconsider =
		decided.verdict === "request_changes" &&
		opts.round !== undefined &&
		opts.round > (opts.policy?.reconsiderAfter ?? DEFAULT_RECONSIDER_AFTER);
	return { ...compiled, body: renderBody(compiled, { reconsider, reReview: opts.reReview, cleared, hints }) };
}

export function toPostReviewInput(review: CompiledReview): PostReviewInput {
	return {
		verdict: review.verdict,
		body: review.body,
		comments: review.comments.map(({ path, oldPath, newLine, oldLine, body }) => ({
			path,
			oldPath,
			newLine,
			oldLine,
			body,
		})),
	};
}

function previewLine(c: CompiledComment): string {
	if (isFileComment(c)) return "file";
	if (c.newLine !== undefined) return `${c.newLine} (new)`;
	return `${c.oldLine} (old)`;
}

export function renderPreview(review: CompiledReview, target: string): string {
	const folded = review.dropped.filter((d) => d.reason === "nit-ladder").length;
	const duplicates = review.dropped.filter((d) => d.reason === "duplicate").length;
	const belowMin = review.dropped.filter((d) => d.reason === "below-min-tier").length;
	const t = review.tally;
	const lines: string[] = [
		`Thrash preview · ${spiceLabel(review.spice)} (${review.spice}/${SPICE_MAX}) · ${target}`,
		`Verdict: ${verdictLabel(review.verdict).toUpperCase()} (${review.reason})`,
		[
			...TIERS.map((tier) => `${TIER_EMOJI[tier]} ${t[tier]}`),
			...(review.improvements === undefined ? [] : [`${IMPROVEMENT_EMOJI} ${review.improvements}`]),
		].join("  "),
		`Posting ${commentCounts(review.comments)}; ` +
			`${folded} folded, ${duplicates} duplicate, ${belowMin} below min tier, ` +
			`${review.unanchored.length} unanchored.`,
		"",
	];
	for (const c of review.comments) {
		lines.push(`${c.path}:${previewLine(c)}`, `  ${c.body}`, "");
	}
	if (review.unanchored.length > 0) {
		lines.push("Unanchored:");
		for (const f of review.unanchored) lines.push(`  ${f.path || "(no path)"} ${renderComment(f)}`);
		lines.push("");
	}
	return lines.join("\n");
}

function pad2(value: number): string {
	return String(value).padStart(2, "0");
}

/** Matches the `YYYY-MM-DD-HHMMSS-NNN.md` glob that /address Phase 1c reads. */
export function addressFileName(now: Date, sequence: number): string {
	const date = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
	const time = `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
	return `${date}-${time}-${String(sequence).padStart(3, "0")}.md`;
}

type StackLink = Pick<PullRequest, "number" | "headRefName" | "baseRefName"> & { state?: PullRequest["state"] };

/** Open PRs sort last so they own a reused branch name; older PRs sort before newer ones. */
function stackOrder(a: StackLink, b: StackLink): number {
	const openA = a.state === undefined || a.state === "OPEN" ? 1 : 0;
	const openB = b.state === undefined || b.state === "OPEN" ? 1 : 0;
	return openA - openB || a.number - b.number;
}

/**
 * Every PR joined to `number` through head and base branches, root first, each parent before its children.
 * Merged and closed PRs may appear; when a branch name was reused, the open PR, else the newest, owns it.
 */
export function stackFor<T extends StackLink>(prs: T[], number: number): T[] {
	const start = prs.find((pr) => pr.number === number);
	if (!start) throw new Error(`#${number} is not in the list of pull requests`);
	const byHead = new Map<string, T>();
	const childrenOf = new Map<string, T[]>();
	for (const pr of [...prs].sort(stackOrder)) {
		byHead.set(pr.headRefName, pr);
		const siblings = childrenOf.get(pr.baseRefName);
		if (siblings) siblings.push(pr);
		else childrenOf.set(pr.baseRefName, [pr]);
	}
	for (const children of childrenOf.values()) children.sort((a, b) => a.number - b.number);
	let root = start;
	const climbed = new Set<number>([root.number]);
	for (let parent = byHead.get(root.baseRefName); parent && !climbed.has(parent.number); ) {
		climbed.add(parent.number);
		root = parent;
		parent = byHead.get(root.baseRefName);
	}
	const ordered: T[] = [];
	const seen = new Set<number>();
	const pending: T[] = [root];
	while (pending.length > 0) {
		const pr = pending.pop() as T;
		if (seen.has(pr.number)) continue;
		seen.add(pr.number);
		ordered.push(pr);
		const children = childrenOf.get(pr.headRefName) ?? [];
		for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]);
	}
	return ordered;
}

export interface TallyRow {
	target: string;
	review: CompiledReview;
	posted?: PostedReview;
}

/** A stack member that thrash does not review: merged (context only) or closed without merging. */
export interface StackStatusRow {
	target: string;
	stackState: "merged" | "closed";
}

export const STACK_STATE_LABEL: Record<StackStatusRow["stackState"], string> = {
	merged: "merged (context only, not reviewed)",
	closed: "closed without merging (not reviewed)",
};

export function isStackStatusRow(row: TallyRow | StackStatusRow): row is StackStatusRow {
	return "stackState" in row;
}

function tallyPrCell(target: string): string {
	const match = /\/(?:pull|merge_requests)\/(\d+)/.exec(target);
	return match ? `#${match[1]}` : target;
}

function tallyVerdictCell(row: TallyRow): string {
	if (!row.posted) return `${verdictLabel(row.review.verdict)} (not posted)`;
	const label = verdictLabel(row.posted.verdict);
	return row.posted.degraded ? `${label} (${verdictLabel(row.review.verdict).toLowerCase()} refused)` : label;
}

/** Markdown summary of one or more reviews: PR, link, findings per tier, comment count, verdict. */
export function renderTallyTable(rows: Array<TallyRow | StackStatusRow>): string {
	const header = `| PR | Link | ${TIERS.map((t) => TIER_EMOJI[t]).join(" | ")} | Comments | Verdict |`;
	const lines = [header, `|${" --- |".repeat(TIERS.length + 4)}`];
	for (const row of rows) {
		if (isStackStatusRow(row)) {
			const blanks = TIERS.map(() => "-").join(" | ");
			lines.push(`| ${tallyPrCell(row.target)} | [PR](${row.target}) | ${blanks} | - | ${STACK_STATE_LABEL[row.stackState]} |`);
			continue;
		}
		const link = row.posted ? `[review](${row.posted.url})` : `[PR](${row.target})`;
		const counts = TIERS.map((t) => row.review.tally[t]).join(" | ");
		const inline = row.posted?.commentCount ?? row.review.comments.length;
		lines.push(`| ${tallyPrCell(row.target)} | ${link} | ${counts} | ${inline} | ${tallyVerdictCell(row)} |`);
	}
	return `${lines.join("\n")}\n`;
}

/** One `## path:line` or `## path (whole file)` section per posted comment, for /address to parse. */
export function renderAddressFile(review: CompiledReview): string {
	const sections = review.comments.filter((c) => c.kind !== "improvement").map((c) => {
		const where = isFileComment(c) ? `${c.path} (whole file)` : `${c.path}:${c.newLine ?? c.oldLine}`;
		return `## ${where}\n\nseverity: ${ADDRESS_SEVERITY[c.tier]}\n\n${c.body}\n`;
	});
	return sections.join("\n");
}
