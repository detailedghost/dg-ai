import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { escapeRegExp, isRecord } from "@dg/common";
import {
	type AgentOutput,
	classKey,
	type Evidence,
	type Finding,
	extractJsonText,
	isTier,
	mergeOutputs,
	parseEvidence,
	parseFinding,
	placeOf,
	type RejectedFinding,
	SPICE_DEFAULT,
	stringList,
	type Tier,
	tierRank,
	VERDICT_LIMITS,
} from "./core";

export const VERIFY_TASK_CAP = 16;

export interface TriagePaths {
	merged: string;
	tasks: string;
	taskPrefix: string;
	verdictPrefix: string;
	verdicts: string;
	consolidateInput: string;
	consolidated: string;
	taskPath(id: string): string;
	verdictPath(id: string): string;
}

export function triagePaths(diffPath: string): TriagePaths {
	const base = path.resolve(diffPath).replace(/\.diff$/, "");
	return {
		merged: `${base}.merged.json`,
		tasks: `${base}.verify.tasks.json`,
		taskPrefix: `${base}.verify.task.`,
		verdictPrefix: `${base}.verdict.`,
		verdicts: `${base}.verdicts.json`,
		consolidateInput: `${base}.consolidate.input.json`,
		consolidated: `${base}.consolidated.md`,
		taskPath: (id) => `${base}.verify.task.${id}.json`,
		verdictPath: (id) => `${base}.verdict.${id}.json`,
	};
}

/** Deletes every triage file of the slug that `diffPath` names. */
export function removeTriageFiles(diffPath: string): void {
	const paths = triagePaths(diffPath);
	const dir = path.dirname(paths.merged);
	if (!existsSync(dir)) return;
	const stem = path.basename(paths.merged, ".merged.json");
	const stale = new RegExp(
		`^${escapeRegExp(stem)}\\.(verdict\\..+|verify\\.task\\..+\\.json|verdicts\\.json|merged\\.json|verify\\.tasks\\.json|consolidate\\.input\\.json|consolidated\\.md)$`,
	);
	for (const name of readdirSync(dir)) if (stale.test(name)) rmSync(path.join(dir, name), { force: true });
}

export interface VerifyTask {
	id: string;
	path: string;
	line: number | null;
	tier: Tier;
	title: string;
	body: string;
	evidence: Evidence[];
	bundleContextPath: string | null;
	verdictPath: string;
}

export interface TriageChunk {
	id: number;
	output: AgentOutput;
	contextPath: string | null;
}

export interface MergeResult {
	merged: AgentOutput;
	tasks: VerifyTask[];
	overCap: string[];
}

export function inVerifyScope(finding: Finding, spice: number): boolean {
	if (finding.kind === "improvement" || finding.tier === "nit") return false;
	if (tierRank(finding.tier) <= tierRank("medium")) return true;
	const limits = VERDICT_LIMITS[spice] ?? VERDICT_LIMITS[SPICE_DEFAULT];
	return limits[finding.tier] !== undefined;
}

function idParts(id: string): [number, number] {
	const match = /^c(\d+)-(\d+)$/.exec(id);
	return match ? [Number(match[1]), Number(match[2])] : [Number.MAX_SAFE_INTEGER, 0];
}

function verifyOrder(a: Finding, b: Finding): number {
	const [chunkA, posA] = idParts(a.id ?? "");
	const [chunkB, posB] = idParts(b.id ?? "");
	return (
		tierRank(a.tier) - tierRank(b.tier) ||
		Number(a.preExisting === true) - Number(b.preExisting === true) ||
		chunkA - chunkB ||
		posA - posB
	);
}

export function mergeChunks(
	chunks: TriageChunk[],
	opts: { spice: number; paths: Pick<TriagePaths, "verdictPath"> },
): MergeResult {
	const contextByChunk = new Map(chunks.map((chunk) => [chunk.id, chunk.contextPath]));
	const merged = mergeOutputs(
		chunks.map((chunk) => ({
			...chunk.output,
			findings: chunk.output.findings.map((finding, index) => ({ ...finding, id: `c${chunk.id}-${index + 1}` })),
		})),
	);
	const ordered = merged.findings.filter((finding) => inVerifyScope(finding, opts.spice)).sort(verifyOrder);
	const tasks = ordered.slice(0, VERIFY_TASK_CAP).map((finding): VerifyTask => {
		const id = finding.id as string;
		return {
			id,
			path: finding.path,
			line: finding.line,
			tier: finding.tier,
			title: finding.title,
			body: finding.body,
			evidence: finding.evidence ?? [],
			bundleContextPath: contextByChunk.get(idParts(id)[0]) ?? null,
			verdictPath: opts.paths.verdictPath(id),
		};
	});
	return { merged, tasks, overCap: ordered.slice(VERIFY_TASK_CAP).map((finding) => finding.id as string) };
}

export const VERDICT_WORDS = ["confirmed", "rejected", "adjusted"] as const;
export type VerdictWord = (typeof VERDICT_WORDS)[number];

export interface Verdict {
	id: string;
	verdict: VerdictWord;
	tier?: Tier;
	reason: string;
	evidence?: Evidence[];
}

export interface ConsolidateInput {
	changed: string;
	strengths: string[];
	opportunities: string[];
	findings: Finding[];
	rejected: RejectedFinding[];
	unverified: string[];
}

export interface VerdictCounts {
	confirmed: number;
	adjusted: number;
	rejected: number;
	unverified: number;
}

export interface ApplyResult {
	verdicts: Verdict[];
	input: ConsolidateInput;
	counts: VerdictCounts;
}

function parseJson(text: string): unknown {
	return JSON.parse(extractJsonText(text));
}

function parseVerdict(text: string | null, taskId: string): Verdict | null {
	if (text === null) return null;
	let raw: unknown;
	try {
		raw = parseJson(text);
	} catch {
		return null;
	}
	if (!isRecord(raw) || raw.id !== taskId) return null;
	const word = VERDICT_WORDS.find((candidate) => candidate === raw.verdict);
	if (!word) return null;
	const verdict: Verdict = { id: taskId, verdict: word, reason: typeof raw.reason === "string" ? raw.reason.trim() : "" };
	if (isTier(raw.tier)) verdict.tier = raw.tier;
	if (raw.evidence !== undefined) verdict.evidence = parseEvidence(raw.evidence);
	return verdict;
}

export interface ApplyInput {
	merged: AgentOutput;
	tasks: VerifyTask[];
	overCap: string[];
	verdictTexts: ReadonlyMap<string, string | null>;
}

/** Reads each task's verdict file; a missing or unreadable file gives null. */
export function readVerdictTexts(tasks: VerifyTask[]): Map<string, string | null> {
	return new Map(
		tasks.map((task) => {
			try {
				return [task.id, readFileSync(task.verdictPath, "utf8")] as const;
			} catch {
				return [task.id, null] as const;
			}
		}),
	);
}

function mergeEvidence(existing: Evidence[], added: Evidence[]): Evidence[] {
	const key = (entry: Evidence) => JSON.stringify([entry.path, entry.line, entry.note]);
	const seen = new Set(existing.map(key));
	return [...existing, ...added.filter((entry) => !seen.has(key(entry)) && seen.add(key(entry)))];
}

export function applyVerdicts({ merged, tasks, overCap, verdictTexts }: ApplyInput): ApplyResult {
	const verdicts: Verdict[] = [];
	const unverified = new Set(overCap);
	const rejected = new Map<string, RejectedFinding>();
	const adjusted = new Map<string, Verdict>();
	const confirmedEvidence = new Map<string, NonNullable<Verdict["evidence"]>>();
	const byId = new Map(merged.findings.map((finding) => [finding.id, finding]));
	const counts: VerdictCounts = { confirmed: 0, adjusted: 0, rejected: 0, unverified: 0 };
	for (const task of tasks) {
		const verdict = parseVerdict(verdictTexts.get(task.id) ?? null, task.id);
		const finding = byId.get(task.id);
		if (!verdict || !finding) {
			unverified.add(task.id);
			continue;
		}
		verdicts.push(verdict);
		if (verdict.verdict === "rejected") rejected.set(task.id, { ...finding, reason: verdict.reason });
		else if (verdict.verdict === "adjusted") {
			if (verdict.tier) adjusted.set(task.id, verdict);
			else unverified.add(task.id);
		} else if (verdict.evidence?.length) confirmedEvidence.set(task.id, verdict.evidence);
	}
	const findings: Finding[] = [];
	for (const finding of merged.findings) {
		const id = finding.id as string;
		if (rejected.has(id)) continue;
		const change = adjusted.get(id);
		const evidence = mergeEvidence(finding.evidence ?? [], change?.evidence ?? confirmedEvidence.get(id) ?? []);
		findings.push({
			...finding,
			...(change?.tier && { tier: change.tier }),
			...(evidence.length > 0 && { evidence }),
		});
	}
	counts.rejected = rejected.size;
	counts.adjusted = adjusted.size;
	counts.unverified = unverified.size;
	counts.confirmed = verdicts.filter((verdict) => verdict.verdict === "confirmed").length;
	const unverifiedIds = merged.findings.map((finding) => finding.id as string).filter((id) => unverified.has(id));
	return {
		verdicts,
		counts,
		input: {
			changed: merged.changed,
			strengths: merged.strengths,
			opportunities: merged.opportunities,
			findings,
			rejected: [...rejected.values()],
			unverified: unverifiedIds,
		},
	};
}

export interface ConsolidatedFinding {
	id?: string;
	title?: string;
	body: string;
	class?: string;
	otherPlaces?: string[];
}

export interface ConsolidatedOutput {
	changed: string;
	strengths: string[];
	opportunities: string[];
	findings: ConsolidatedFinding[];
}

export function parseConsolidated(text: string): ConsolidatedOutput {
	const parsed = parseJson(text);
	if (!isRecord(parsed) || !Array.isArray(parsed.findings)) {
		throw new Error('consolidated output must be an object with a "findings" array');
	}
	const findings = parsed.findings.map((raw: unknown, index: number): ConsolidatedFinding => {
		if (!isRecord(raw)) throw new Error(`consolidated finding ${index}: must be an object`);
		const body = typeof raw.body === "string" ? raw.body.trim() : "";
		if (!body) throw new Error(`consolidated finding ${index}: body is required`);
		const cls = typeof raw.class === "string" ? raw.class.trim() : "";
		const title = typeof raw.title === "string" ? raw.title.trim() : "";
		const otherPlaces = stringList(raw.otherPlaces);
		return {
			...(typeof raw.id === "string" && raw.id && { id: raw.id }),
			...(title && { title }),
			body,
			...(cls && { class: cls }),
			...(otherPlaces.length > 0 && { otherPlaces }),
		};
	});
	return {
		changed: typeof parsed.changed === "string" ? parsed.changed.trim() : "",
		strengths: stringList(parsed.strengths),
		opportunities: stringList(parsed.opportunities),
		findings,
	};
}

function parseFindingList(raw: unknown[], label: string): Finding[] {
	return raw.map((entry, index) => {
		if (!isRecord(entry)) throw new Error(`${label} ${index}: must be an object`);
		return parseFinding(entry, index);
	});
}

function parseRejected(raw: unknown[]): RejectedFinding[] {
	const findings = parseFindingList(raw, "rejected finding");
	return findings.map((finding, index) => {
		const reason = (raw[index] as Record<string, unknown>).reason;
		return { ...finding, reason: typeof reason === "string" ? reason : "" };
	});
}

export function parseConsolidateInput(text: string): ConsolidateInput {
	const parsed = parseJson(text);
	if (!isRecord(parsed) || !Array.isArray(parsed.findings)) {
		throw new Error('consolidate input must be an object with a "findings" array');
	}
	return {
		changed: typeof parsed.changed === "string" ? parsed.changed : "",
		strengths: stringList(parsed.strengths),
		opportunities: stringList(parsed.opportunities),
		findings: parseFindingList(parsed.findings, "finding"),
		rejected: Array.isArray(parsed.rejected) ? parseRejected(parsed.rejected) : [],
		unverified: stringList(parsed.unverified),
	};
}

export interface CompileSources {
	consolidated: ConsolidatedOutput | { error: string } | null;
	input: ConsolidateInput | null;
	chunkOutput: () => AgentOutput;
}

export interface MatchKey {
	title: string;
	class?: string;
}

export interface ResolvedFindings {
	output: AgentOutput;
	rejected: RejectedFinding[];
	unverified: number;
	warnings: string[];
	matchKeys: ReadonlyMap<string, MatchKey>;
}

function fromInput(input: ConsolidateInput, warnings: string[]): ResolvedFindings {
	const ids = new Set(input.unverified);
	return {
		output: { changed: input.changed, strengths: input.strengths, opportunities: input.opportunities, findings: input.findings },
		rejected: input.rejected,
		unverified: input.findings.filter((finding) => finding.id !== undefined && ids.has(finding.id)).length,
		warnings,
		matchKeys: new Map(),
	};
}

function fromChunks(sources: CompileSources, warnings: string[]): ResolvedFindings {
	return { output: sources.chunkOutput(), rejected: [], unverified: 0, warnings, matchKeys: new Map() };
}

function pickGrouped(candidates: Finding[], keeper: Finding, consolidatedClass: string): Finding | undefined {
	const narrowed =
		candidates.length > 1
			? candidates.filter(
					(candidate) =>
						candidate.side === keeper.side &&
						(!candidate.class || classKey(candidate.class) === classKey(consolidatedClass)),
				)
			: candidates;
	return narrowed.find((candidate) => candidate.preExisting === keeper.preExisting && candidate.kind === keeper.kind);
}

export function resolveCompileFindings(sources: CompileSources): ResolvedFindings {
	const { consolidated, input } = sources;
	if (consolidated === null) return input ? fromInput(input, []) : fromChunks(sources, []);
	if ("error" in consolidated) {
		const warnings = [`consolidated file does not parse (${consolidated.error}), using the review input`];
		return input ? fromInput(input, warnings) : fromChunks(sources, warnings);
	}
	if (!input) {
		return fromChunks(sources, ["consolidated file has no consolidate input beside it, using the chunk findings"]);
	}

	const warnings: string[] = [];
	const inputById = new Map(input.findings.flatMap((finding) => (finding.id ? [[finding.id, finding] as const] : [])));
	const kept = new Map<string, Finding>();
	const keepers: Array<{ finding: Finding; consolidated: ConsolidatedFinding }> = [];
	for (const entry of consolidated.findings) {
		const base = entry.id === undefined ? undefined : inputById.get(entry.id);
		if (!base || entry.id === undefined) {
			warnings.push(
				entry.id === undefined
					? "dropped a consolidated finding with no id"
					: `dropped consolidated finding with unknown id ${entry.id}`,
			);
			continue;
		}
		if (kept.has(entry.id)) {
			warnings.push(`dropped consolidated finding with duplicate id ${entry.id}`);
			continue;
		}
		const { class: _class, otherPlaces: _otherPlaces, ...rest } = base;
		const finding: Finding = {
			...rest,
			title: entry.title ?? base.title,
			body: entry.body,
			...(entry.class && { class: entry.class }),
			...(entry.otherPlaces && { otherPlaces: entry.otherPlaces }),
		};
		kept.set(entry.id, finding);
		keepers.push({ finding, consolidated: entry });
	}

	const claimed = new Set<string>();
	for (const { finding, consolidated: entry } of keepers) {
		if (!entry.class) continue;
		for (const place of entry.otherPlaces ?? []) {
			const candidates = input.findings.filter(
				(candidate) => candidate.id && !kept.has(candidate.id) && !claimed.has(candidate.id) && placeOf(candidate) === place,
			);
			const grouped = pickGrouped(candidates, inputById.get(finding.id as string) ?? finding, entry.class);
			if (!grouped?.id) continue;
			claimed.add(grouped.id);
			if (tierRank(grouped.tier) < tierRank(finding.tier)) finding.tier = grouped.tier;
		}
	}

	const addedBack = input.findings.filter((finding) => !finding.id || (!kept.has(finding.id) && !claimed.has(finding.id)));
	const findings = [...keepers.map((keeper) => keeper.finding), ...addedBack];
	const matchKeys = new Map<string, MatchKey>();
	for (const finding of findings) {
		if (!finding.id) continue;
		const original = inputById.get(finding.id) ?? finding;
		matchKeys.set(finding.id, { title: original.title, ...(original.class && { class: original.class }) });
	}
	const unverifiedIds = new Set(input.unverified);
	return {
		output: {
			changed: consolidated.changed || input.changed,
			strengths: consolidated.strengths.length > 0 ? consolidated.strengths : input.strengths,
			opportunities: consolidated.opportunities.length > 0 ? consolidated.opportunities : input.opportunities,
			findings,
		},
		rejected: input.rejected,
		unverified: findings.filter((finding) => finding.id && unverifiedIds.has(finding.id)).length,
		warnings,
		matchKeys,
	};
}
