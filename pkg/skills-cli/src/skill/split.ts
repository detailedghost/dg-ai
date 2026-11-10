import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { stateRoot } from "@dg/common/node";
import { headingKeyword, nearAboveBelow } from "./audit";

export interface Section {
	slug: string;
	heading: string;
	startLine: number;
	endLine: number;
	tokens: number;
}

export interface Move {
	slug: string;
	dest: string;
}

export interface ApplyResult {
	backup: string;
	moved: number;
	dests: string[];
	entry: string;
	warnings: string[];
}

/** A manifest or entry problem; the CLI reports it and exits 2. */
export class SplitError extends Error {}

const slugify = (s: string) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");

const isTableRow = (line: string) => /^\s*\|.*\|\s*$/.test(line);

/** H2 sections outside code fences; duplicate slugs get a -2, -3 suffix. */
export function parseSections(lines: string[]): { preamble: number; sections: Section[] } {
	let fenceDelim: string | null = null;
	const starts: { line: number; heading: string }[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const delim = line.match(/^(```|~~~)/)?.[1];
		if (delim) {
			if (fenceDelim === null) fenceDelim = delim;
			else if (fenceDelim === delim) fenceDelim = null;
		}
		if (fenceDelim === null && line.startsWith("## ")) starts.push({ line: i, heading: line.slice(3).trim() });
	}
	const slugCounts = new Map<string, number>();
	const sections = starts.map((start, s) => {
		const end = starts[s + 1]?.line ?? lines.length;
		const base = slugify(start.heading);
		const seen = (slugCounts.get(base) ?? 0) + 1;
		slugCounts.set(base, seen);
		return {
			slug: seen === 1 ? base : `${base}-${seen}`,
			heading: start.heading,
			startLine: start.line,
			endLine: end,
			tokens: Math.round(lines.slice(start.line, end).join("\n").length / 4),
		};
	});
	return { preamble: starts[0]?.line ?? lines.length, sections };
}

/** A kept "Routing" or "References" H2 that new router rows merge into. */
export function findExistingRouter(sections: Section[], movedSlugs: Set<string>): Section | undefined {
	return sections.find((s) => !movedSlugs.has(s.slug) && /^(routing|references\b)/i.test(s.heading));
}

/** Kept prose that still points "above"/"below" at a moved section. */
export function detectDanglingReferences(remainingText: string, moves: Move[], bySlug: Map<string, Section>): string[] {
	const warnings: string[] = [];
	const lines = remainingText.split("\n");
	for (const mv of moves) {
		const heading = bySlug.get(mv.slug)?.heading;
		const keyword = heading ? headingKeyword(heading) : undefined;
		if (!heading || !keyword) continue;
		const re = nearAboveBelow(keyword);
		lines.forEach((line, i) => {
			if (re.test(line))
				warnings.push(
					`possible dangling reference at line ${i + 1}: mentions "${keyword}" near "above"/"below", but "${heading}" moved to ${mv.dest} — verify and reword`,
				);
		});
	}
	return warnings;
}

export function resolveEntry(skillDir: string, override?: string): string {
	if (override !== undefined) {
		const p = join(skillDir, override);
		if (!existsSync(p)) throw new SplitError(`entry not found: ${p}`);
		return p;
	}
	for (const name of ["SKILL.md", "skill.md"]) {
		const p = join(skillDir, name);
		if (existsSync(p)) return p;
	}
	throw new SplitError(`no SKILL.md or skill.md in ${skillDir}`);
}

export function listSections(skillDir: string, entryOverride?: string) {
	const entryPath = resolveEntry(skillDir, entryOverride);
	const { sections } = parseSections(readFileSync(entryPath, "utf8").split("\n"));
	return {
		skillDir,
		entry: basename(entryPath),
		sections: sections.map(({ startLine: _s, endLine: _e, ...s }) => s),
	};
}

function readManifest(manifestPath: string): { skillDir: string; entry?: string; moves: Move[] } {
	const m = JSON.parse(readFileSync(manifestPath, "utf8"));
	if (typeof m.skillDir !== "string" || m.skillDir.length === 0)
		throw new SplitError("manifest error: skillDir must be a non-empty string");
	if (!Array.isArray(m.moves) || m.moves.length === 0)
		throw new SplitError("manifest error: moves must be a non-empty array");
	for (const mv of m.moves)
		if (typeof mv?.slug !== "string" || typeof mv?.dest !== "string")
			throw new SplitError(`manifest error: each move needs string slug/dest, got ${JSON.stringify(mv)}`);
	return { skillDir: m.skillDir.replace(/\/$/, ""), entry: m.entry, moves: m.moves };
}

/** Move the manifest's sections verbatim into reference files after a durable backup. */
export function applyManifest(manifestPath: string): ApplyResult {
	const { skillDir, entry, moves } = readManifest(manifestPath);
	const entryPath = resolveEntry(skillDir, entry);
	const lines = readFileSync(entryPath, "utf8").split("\n");
	const { sections } = parseSections(lines);
	const bySlug = new Map(sections.map((s) => [s.slug, s]));
	const missing = moves.filter((mv) => !bySlug.has(mv.slug)).map((mv) => mv.slug);
	if (missing.length) throw new SplitError(`unknown section slug(s): ${missing.join(", ")}`);
	const sectionOf = (slug: string) => bySlug.get(slug) as Section;

	const backup = join(stateRoot(), "skill-cleanup", "backups", `${basename(skillDir)}-${Date.now()}`);
	mkdirSync(dirname(backup), { recursive: true });
	cpSync(skillDir, backup, { recursive: true });

	const destContent = new Map<string, string[]>();
	for (const mv of moves) {
		const sec = sectionOf(mv.slug);
		const chunks = destContent.get(mv.dest) ?? [];
		chunks.push(lines.slice(sec.startLine, sec.endLine).join("\n").trimEnd());
		destContent.set(mv.dest, chunks);
	}
	for (const [dest, chunks] of destContent) {
		const full = join(skillDir, dest);
		mkdirSync(dirname(full), { recursive: true });
		const fileExists = existsSync(full);
		const existing = fileExists ? `${readFileSync(full, "utf8").trimEnd()}\n\n` : "";
		const [first = "", ...rest] = chunks;
		const promoted = fileExists ? chunks : [first.replace(/^## /, "# "), ...rest];
		writeFileSync(full, `${existing}${promoted.join("\n\n")}\n`);
	}

	const movedSlugs = new Set(moves.map((mv) => mv.slug));
	const newRows = moves.map((mv) => `| ${sectionOf(mv.slug).heading} | \`${mv.dest}\` |`);
	const existingRouter = findExistingRouter(sections, movedSlugs);
	const firstMoved = Math.min(...moves.map((mv) => sectionOf(mv.slug).startLine));
	const out: string[] = [];
	for (let i = 0; i < lines.length; ) {
		const sec = sections.find((s) => s.startLine === i);
		if (sec && movedSlugs.has(sec.slug)) {
			if (!existingRouter && i === firstMoved)
				out.push("## Routing", "", "| Task | Read |", "|---|---|", ...newRows, "");
			i = sec.endLine;
			continue;
		}
		if (sec && sec === existingRouter) {
			const body = lines.slice(sec.startLine, sec.endLine);
			const lastRow = body.reduce((last, l, j) => (isTableRow(l) ? j : last), -1);
			if (lastRow === -1) out.push(...body, ...newRows);
			else out.push(...body.slice(0, lastRow + 1), ...newRows, ...body.slice(lastRow + 1));
			i = sec.endLine;
			continue;
		}
		out.push(lines[i] ?? "");
		i++;
	}

	const finalEntryText = out.join("\n").replace(/\n{3,}/g, "\n\n");
	writeFileSync(entryPath, finalEntryText);
	return {
		backup,
		moved: moves.length,
		dests: [...destContent.keys()],
		entry: entryPath,
		warnings: detectDanglingReferences(finalEntryText, moves, bySlug),
	};
}
