import { escapeRegExp } from "@dg/common";
import type { CheckoutResult } from "./checkout";
import {
	byPath,
	CATEGORY_ORDER,
	type ChunkBundle,
	type ChunkCategory,
	type ChunkPlan,
	categoryOf,
	commonDirectory,
	type DiffChunk,
	type DiffFile,
	LARGE_DIFF_LINES,
	MAX_CHUNKS,
	mergeNeighbors,
	planChunks,
	splitIntoChunks,
	sumChanged,
} from "./core";
import type { CallerHit, InvestigateOptions, Investigation } from "./investigate";

export const TINY_DIFF_LINES = 100;
export const BUNDLE_TARGET_LINES = 400;

export interface ReviewChunkDeps {
	investigate: (
		root: string,
		paths: string[],
		options: InvestigateOptions & { diffFiles: Map<string, DiffFile> },
	) => Investigation;
	maxHits: number;
	budgetMs: number;
}

export interface ReviewChunkPlan {
	plan: ChunkPlan;
	contexts: Map<number, string>;
	warnings: string[];
}

interface Group {
	category: ChunkCategory;
	files: DiffFile[];
}

interface BundleDetails {
	bundle: ChunkBundle;
	callers: CallerHit[];
	truncated: string[];
}

function bestCategory(files: DiffFile[]): ChunkCategory {
	const ranks = files.map((f) => CATEGORY_ORDER.indexOf(categoryOf(f.path)));
	return CATEGORY_ORDER[Math.min(...ranks)];
}

function findConcerns(files: DiffFile[], investigation: Investigation): DiffFile[][] {
	const parent = new Map(files.map((f) => [f.path, f.path]));
	const find = (path: string): string => {
		let root = path;
		while (parent.get(root) !== root) root = parent.get(root) as string;
		parent.set(path, root);
		return root;
	};
	const link = (a: string, b: string) => {
		if (a === b || !parent.has(a) || !parent.has(b)) return;
		parent.set(find(a), find(b));
	};
	for (const entry of investigation.files) {
		for (const path of [...entry.dependents, ...entry.tests]) link(entry.path, path);
		if (entry.truncated) continue;
		for (const caller of entry.callers) link(entry.path, caller.path);
	}
	const members = new Map<string, DiffFile[]>();
	for (const file of files) {
		const root = find(file.path);
		members.set(root, [...(members.get(root) ?? []), file]);
	}
	return [...members.values()].sort((a, b) => {
		const rank = CATEGORY_ORDER.indexOf(bestCategory(a)) - CATEGORY_ORDER.indexOf(bestCategory(b));
		return rank !== 0 ? rank : byPath(a[0], b[0]);
	});
}

function mentions(texts: string[], symbol: string): boolean {
	const pattern = new RegExp(`(?<![\\w$])${escapeRegExp(symbol)}(?![\\w$])`);
	return texts.some((text) => pattern.test(text));
}

function sorted(values: Iterable<string>): string[] {
	return [...new Set(values)].sort();
}

function bundleDetails(files: DiffFile[], investigation: Investigation): BundleDetails {
	const entries = new Map(investigation.files.map((f) => [f.path, f]));
	const texts = new Map<string, string[]>();
	for (const file of files) {
		const changed = file.lines.filter((l) => l.kind !== "context").map((l) => l.text);
		texts.set(file.path, [...(texts.get(file.path) ?? []), ...changed]);
	}
	const paths = [...texts.keys()];
	const own = new Set(paths);
	const symbols = new Set<string>();
	const callers = new Map<string, CallerHit>();
	const dependents = new Set<string>();
	const tests = new Set<string>();
	const truncated: string[] = [];
	for (const path of paths) {
		const entry = entries.get(path);
		if (!entry) continue;
		const changed = texts.get(path) ?? [];
		const kept = new Set(entry.symbols.filter((symbol) => mentions(changed, symbol)));
		for (const symbol of kept) symbols.add(symbol);
		for (const caller of entry.callers) {
			if (kept.has(caller.symbol)) callers.set(`${caller.path}:${caller.line}:${caller.symbol}`, caller);
		}
		for (const dependent of entry.dependents) dependents.add(dependent);
		for (const test of entry.tests) tests.add(test);
		if (entry.truncated) truncated.push(path);
	}
	const outside = (values: Iterable<string>) => sorted([...values].filter((p) => !own.has(p)));
	const callerList = [...callers.values()];
	return {
		bundle: {
			files: paths,
			symbols: [...symbols],
			dependents: outside(dependents),
			tests: outside(tests),
			related: outside(callerList.map((c) => c.path).filter((p) => !dependents.has(p))),
		},
		callers: callerList,
		truncated,
	};
}

function toChunks(groups: Group[], investigation: Investigation): DiffChunk[] {
	return groups.map(({ files }, i) => {
		const categories = new Set(files.map((f) => categoryOf(f.path)));
		const label = categories.size === 1 ? [...categories][0] : "mixed";
		return {
			id: i + 1,
			label: `${label}: ${commonDirectory(files)}`,
			files,
			changed: sumChanged(files),
			bundle: bundleDetails(files, investigation).bundle,
		};
	});
}

/** Plans one bundle per concern; a diff of `TINY_DIFF_LINES` or fewer is one bundle. */
export function planBundles(files: DiffFile[], investigation: Investigation): ChunkPlan {
	if (files.length === 0) return { chunks: [], skipped: [] };
	if (sumChanged(files) <= TINY_DIFF_LINES) {
		const whole = { id: 1, label: "whole diff", files, changed: sumChanged(files) };
		return { chunks: [{ ...whole, bundle: bundleDetails(files, investigation).bundle }], skipped: [] };
	}
	const sortedFiles = [...files].sort(byPath);
	const source = sortedFiles.filter((f) => categoryOf(f.path) !== "generated");
	const generated = sortedFiles.filter((f) => categoryOf(f.path) === "generated");
	const groups: Group[] = [];
	for (const concern of findConcerns(source, investigation)) {
		const parts = sumChanged(concern) > BUNDLE_TARGET_LINES ? splitIntoChunks(concern, BUNDLE_TARGET_LINES) : [concern];
		for (const part of parts) groups.push({ category: bestCategory(part), files: part });
	}
	groups.sort(
		(a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || byPath(a.files[0], b.files[0]),
	);
	const skipped: string[] = [];
	const kept: DiffFile[] = [];
	let weight = 0;
	for (const file of generated) {
		const cost = sumChanged([file]);
		if (weight + cost > LARGE_DIFF_LINES) skipped.push(file.path);
		else {
			kept.push(file);
			weight += cost;
		}
	}
	if (kept.length > 0) groups.push({ category: "generated", files: kept });
	return { chunks: toChunks(mergeNeighbors(groups, MAX_CHUNKS), investigation), skipped };
}

function listSection(title: string, items: string[]): string[] {
	return items.length === 0 ? [] : [`## ${title}`, ...items.map((item) => `- ${item}`), ""];
}

export function renderBundleContext(chunk: DiffChunk, investigation: Investigation): string {
	const { bundle, callers, truncated } = bundleDetails(chunk.files, investigation);
	const lines = [`# Bundle ${chunk.id}: ${chunk.label}`, ""];
	lines.push(...listSection("Files", bundle.files));
	lines.push(...listSection("Symbols", bundle.symbols.map((s) => `\`${s}\``)));
	lines.push(...listSection("Dependents", bundle.dependents));
	lines.push(
		...listSection(
			"Callers",
			callers.map((c) => `${c.path}:${c.line} (\`${c.symbol}\`)`),
		),
	);
	lines.push(...listSection("Related", bundle.related));
	lines.push(...listSection("Tests", bundle.tests));
	if (truncated.length > 0) {
		lines.push("## Truncated files", "Investigation was cut for these files. Dependents, callers and tests may be missing.");
		lines.push(...truncated.map((path) => `- ${path}`), "");
	}
	return lines.join("\n");
}

function budgetCutCount(files: DiffFile[], investigation: Investigation): number {
	const paths = new Set(files.map((f) => f.path));
	return investigation.files.filter((f) => paths.has(f.path) && f.truncated && f.callers.length === 0).length;
}

/** Plans bundles for a local tree; falls back to `planChunks` when there is no tree or investigate fails. */
export function planReviewChunks(
	files: DiffFile[],
	repo: Pick<CheckoutResult, "root" | "source"> | undefined,
	deps: ReviewChunkDeps,
): ReviewChunkPlan {
	const plain = (warnings: string[] = []): ReviewChunkPlan => ({
		plan: planChunks(files),
		contexts: new Map(),
		warnings,
	});
	if (!repo || (repo.source !== "cwd" && repo.source !== "clone") || files.length === 0) return plain();
	try {
		const investigation = deps.investigate(
			repo.root,
			[...new Set(files.map((f) => f.path))],
			{ maxHits: deps.maxHits, budgetMs: deps.budgetMs, diffFiles: new Map(files.map((f) => [f.path, f])) },
		);
		const plan = planBundles(files, investigation);
		const contexts = new Map(plan.chunks.map((chunk) => [chunk.id, renderBundleContext(chunk, investigation)]));
		const cut = budgetCutCount(files, investigation);
		const warnings = cut > 0 ? [`thrash: investigate budget ended; ${cut} file(s) truncated`] : [];
		return { plan, contexts, warnings };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return plain([`thrash: investigate failed (${reason}); planned chunks without bundles`]);
	}
}
