import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { stateDir } from "@dg/common/node";

export interface Section {
	slug: string;
	heading: string;
	startLine: number;
	endLine: number;
	tokens: number;
}

const slugify = (s: string): string =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");

export function parseSections(lines: string[]): { preamble: number; sections: Section[] } {
	const sections: Section[] = [];
	/** Which delimiter opened the current fence — a ``` block containing a nested ~~~ line must not
	 * close on the mismatched delimiter, or "## " lines inside it leak out as phantom sections. */
	let fenceDelim: "```" | "~~~" | null = null;
	const starts: { line: number; heading: string }[] = [];
	for (let i = 0; i < lines.length; i++) {
		const fenceMatch = lines[i].match(/^(```|~~~)/);
		if (fenceMatch) {
			const delim = fenceMatch[1] as "```" | "~~~";
			if (fenceDelim === null) fenceDelim = delim;
			else if (fenceDelim === delim) fenceDelim = null;
		}
		if (fenceDelim === null && /^## /.test(lines[i])) starts.push({ line: i, heading: lines[i].slice(3).trim() });
	}
	const slugCounts = new Map<string, number>();
	for (let s = 0; s < starts.length; s++) {
		const start = starts[s].line;
		const end = s + 1 < starts.length ? starts[s + 1].line : lines.length;
		const body = lines.slice(start, end).join("\n");
		const base = slugify(starts[s].heading);
		const seen = (slugCounts.get(base) ?? 0) + 1;
		slugCounts.set(base, seen);
		sections.push({
			slug: seen === 1 ? base : `${base}-${seen}`,
			heading: starts[s].heading,
			startLine: start,
			endLine: end,
			tokens: Math.round(body.length / 4),
		});
	}
	return { preamble: starts.length ? starts[0].line : lines.length, sections };
}

/** Does the entry already have a router table (a "Routing" or "References ..." H2) not among the
 * sections being moved? apply() merges new rows into it instead of inserting a second placeholder. */
export function findExistingRouter(sections: Section[], movedSlugs: Set<string>): Section | undefined {
	return sections.find((s) => !movedSlugs.has(s.slug) && /^(routing|references\b)/i.test(s.heading));
}

const isTableRow = (line: string): boolean => /^\s*\|.*\|\s*$/.test(line);

/** The heading's most distinctive word (e.g. "Dimensions" from "Dimensions (quality only — see Out
 * of scope)") — used to spot same-file prose that still refers to a section by name after it moves. */
export function headingKeyword(heading: string): string | undefined {
	const stripped = heading
		.replace(/\(.*/, "")
		.replace(/[^a-zA-Z0-9 ]/g, "")
		.trim();
	const words = stripped.split(/\s+/).filter((w) => w.length >= 4);
	if (words.length === 0) return undefined;
	return words.sort((a, b) => b.length - a.length)[0];
}

/** A moved section's content is gone, but prose like "the eight Dimensions above" pointing at it
 * isn't rewritten automatically — flag it so the router rewrite catches it. */
export function detectDanglingReferences(
	remainingText: string,
	moves: { slug: string; dest: string }[],
	bySlug: Map<string, Section>,
): string[] {
	const warnings: string[] = [];
	const lines = remainingText.split("\n");
	for (const mv of moves) {
		const heading = bySlug.get(mv.slug)?.heading;
		if (!heading) continue;
		const keyword = headingKeyword(heading);
		if (!keyword) continue;
		const re = new RegExp(
			`\\b${keyword}\\b[^\\n]{0,60}\\b(above|below)\\b|\\b(above|below)\\b[^\\n]{0,60}\\b${keyword}\\b`,
			"i",
		);
		lines.forEach((line, i) => {
			if (re.test(line)) {
				warnings.push(
					`possible dangling reference at line ${i + 1}: mentions "${keyword}" near "above"/"below", but "${heading}" moved to ${mv.dest} — verify and reword`,
				);
			}
		});
	}
	return warnings;
}

export function resolveEntry(skillDir: string, override?: string): string {
	if (override !== undefined) {
		const p = join(skillDir, override);
		if (!existsSync(p)) throw new Error(`entry not found: ${p}`);
		return p;
	}
	const upper = join(skillDir, "SKILL.md");
	if (existsSync(upper)) return upper;
	const lower = join(skillDir, "skill.md");
	if (existsSync(lower)) return lower;
	throw new Error(`no SKILL.md or skill.md in ${skillDir}`);
}

export function list(skillDir: string, entryOverride?: string): void {
	const entryPath = resolveEntry(skillDir, entryOverride);
	const lines = readFileSync(entryPath, "utf8").split("\n");
	const { sections } = parseSections(lines);
	process.stdout.write(
		`${JSON.stringify(
			{ skillDir, entry: basename(entryPath), sections: sections.map(({ startLine, endLine, ...s }) => s) },
			null,
			2,
		)}\n`,
	);
}

interface Manifest {
	skillDir: string;
	entry?: string;
	moves: { slug: string; dest: string }[];
}

function readManifest(manifestPath: string): Manifest {
	const m = JSON.parse(readFileSync(manifestPath, "utf8"));
	if (typeof m.skillDir !== "string" || m.skillDir.length === 0) {
		throw new Error("manifest error: skillDir must be a non-empty string");
	}
	if (!Array.isArray(m.moves) || m.moves.length === 0) {
		throw new Error("manifest error: moves must be a non-empty array");
	}
	for (const mv of m.moves) {
		if (typeof mv?.slug !== "string" || typeof mv?.dest !== "string") {
			throw new Error(`manifest error: each move needs string slug/dest, got ${JSON.stringify(mv)}`);
		}
	}
	return m as Manifest;
}

export function apply(manifestPath: string): void {
	const m = readManifest(manifestPath);
	const skillDir = m.skillDir.replace(/\/$/, "");
	const entryPath = resolveEntry(skillDir, m.entry);
	const lines = readFileSync(entryPath, "utf8").split("\n");
	const { sections } = parseSections(lines);
	const bySlug = new Map(sections.map((s) => [s.slug, s]));

	const moves = m.moves;
	const missing = moves.filter((mv) => !bySlug.has(mv.slug)).map((mv) => mv.slug);
	if (missing.length) throw new Error(`unknown section slug(s): ${missing.join(", ")}`);

	/** Durable root: a pre-restructure backup lost to a reboot is not a backup. */
	const backup = join(stateDir("skill-cleanup", { cwdScope: false }), "backups", `${basename(skillDir)}-${Date.now()}`);
	mkdirSync(dirname(backup), { recursive: true });
	cpSync(skillDir, backup, { recursive: true });

	const destContent = new Map<string, string[]>();
	for (const mv of moves) {
		const sec = bySlug.get(mv.slug);
		if (!sec) continue;
		const chunk = lines.slice(sec.startLine, sec.endLine).join("\n").trimEnd();
		if (!destContent.has(mv.dest)) destContent.set(mv.dest, []);
		destContent.get(mv.dest)?.push(chunk);
	}
	for (const [dest, chunks] of destContent) {
		const full = join(skillDir, dest);
		mkdirSync(dirname(full), { recursive: true });
		/** Promote the first chunk's H2 → H1 only for a brand-new reference file — appending to one
		 * that already exists must not add a second H1. */
		const fileExists = existsSync(full);
		const existing = fileExists ? `${readFileSync(full, "utf8").trimEnd()}\n\n` : "";
		const promotedChunks = fileExists ? chunks : [chunks[0].replace(/^## /, "# "), ...chunks.slice(1)];
		writeFileSync(full, existing + promotedChunks.join("\n\n") + "\n");
	}

	const movedSlugs = new Set(moves.map((mv) => mv.slug));
	const newRows = moves.map((mv) => {
		const sec = bySlug.get(mv.slug);
		return `| ${sec?.heading} | \`${mv.dest}\` |`;
	});
	const existingRouter = findExistingRouter(sections, movedSlugs);

	const out: string[] = [];
	if (existingRouter) {
		for (let i = 0; i < lines.length; ) {
			const sec = sections.find((s) => s.startLine === i);
			if (sec && movedSlugs.has(sec.slug)) {
				i = sec.endLine;
				continue;
			}
			if (sec === existingRouter) {
				const body = lines.slice(sec.startLine, sec.endLine);
				const lastTableRow = body.reduce((last, l, j) => (isTableRow(l) ? j : last), -1);
				if (lastTableRow === -1) out.push(...body, ...newRows);
				else out.push(...body.slice(0, lastTableRow + 1), ...newRows, ...body.slice(lastTableRow + 1));
				i = sec.endLine;
				continue;
			}
			out.push(lines[i]);
			i++;
		}
	} else {
		const firstMoved = Math.min(...moves.map((mv) => bySlug.get(mv.slug)?.startLine ?? Number.POSITIVE_INFINITY));
		const router = ["## Routing", "", "| Task | Read |", "|---|---|", ...newRows, ""];
		for (let i = 0; i < lines.length; ) {
			const sec = sections.find((s) => s.startLine === i);
			if (sec && movedSlugs.has(sec.slug)) {
				if (i === firstMoved) out.push(...router);
				i = sec.endLine;
			} else {
				out.push(lines[i]);
				i++;
			}
		}
	}

	const finalEntryText = out.join("\n").replace(/\n{3,}/g, "\n\n");
	writeFileSync(entryPath, finalEntryText);

	const warnings = detectDanglingReferences(finalEntryText, moves, bySlug);
	for (const w of warnings) process.stderr.write(`⚠ ${w}\n`);

	process.stdout.write(
		`${JSON.stringify(
			{ backup, moved: moves.length, dests: [...destContent.keys()], entry: entryPath, warnings },
			null,
			2,
		)}\n`,
	);
}

const USAGE = "usage: skill-split --list <skill-dir> [--entry <file>] | --apply <manifest.json>";

/** Dispatch --list/--apply with the legacy usage-error exit code (2) for any failure. */
export function main(argv: string[]): number {
	if (argv.includes("--help") || argv.includes("-h")) {
		process.stdout.write(`${USAGE}\n`);
		return 0;
	}
	try {
		if (argv[0] === "--list" && argv[1]) {
			const entryFlagIdx = argv.indexOf("--entry");
			const entryOverride = entryFlagIdx !== -1 ? argv[entryFlagIdx + 1] : undefined;
			list(argv[1], entryOverride);
			return 0;
		}
		if (argv[0] === "--apply" && argv[1]) {
			apply(argv[1]);
			return 0;
		}
		process.stderr.write(`${USAGE}\n`);
		return 2;
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		return 2;
	}
}
