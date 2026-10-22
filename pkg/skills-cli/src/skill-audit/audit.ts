import { existsSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".git", "examples"]);
const JUNK = [/Zone\.Identifier$/, /\.DS_Store$/, /Thumbs\.db$/];
const DESC_LIMIT = 500;

export const approxTokens = (n: number): number => Math.round(n / 4);

export interface FileEntry {
	path: string;
	tokens: number;
	isEntryPoint: boolean;
}

export interface Audit {
	skill: string;
	dir: string;
	vendor: boolean;
	totalTokens: number;
	files: FileEntry[];
	issues: string[];
	fixed: string[];
	junk: string[];
}

function walk(dir: string, root: string, out: FileEntry[], junk: string[], vendor: { v: boolean }): void {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		const st = statSync(full);
		if (st.isDirectory()) {
			if (!SKIP_DIRS.has(name)) walk(full, root, out, junk, vendor);
			continue;
		}
		if (JUNK.some((re) => re.test(name))) {
			junk.push(full);
			continue;
		}
		if (name === "ATTRIBUTION.md") vendor.v = true;
		if (!name.endsWith(".md")) continue;
		out.push({
			path: relative(root, full),
			tokens: approxTokens(st.size),
			isEntryPoint: /^skill\.md$/i.test(name),
		});
	}
}

const SCAN_RE = /~~~[\s\S]*?~~~|```[\s\S]*?```|`[^`]*`|\[[^\]]*\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/g;

export function brokenLinks(root: string, files: FileEntry[]): string[] {
	const out: string[] = [];
	const skillsRoot = dirname(root);
	for (const f of files) {
		const text = readFileSync(join(root, f.path), "utf8");
		const seen = new Set<string>();
		SCAN_RE.lastIndex = 0;
		for (const m of text.matchAll(SCAN_RE)) {
			const href = m[1];
			if (!href) continue;
			if (href.startsWith("http") || href.startsWith("~")) continue;
			if (!href.includes("/")) continue;
			if (seen.has(href)) continue;
			seen.add(href);
			const bases: string[] = [];
			for (let d = dirname(join(root, f.path)); d.startsWith(skillsRoot); d = dirname(d)) bases.push(d);
			bases.push(skillsRoot);
			if (!bases.some((b) => existsSync(join(b, href)))) out.push(`${f.path} → ${href}`);
		}
	}
	return out;
}

function descriptionLength(root: string): number {
	try {
		const head = readFileSync(join(root, "SKILL.md"), "utf8").slice(0, 4000);
		const m = head.match(/^description:\s*(.+)$/m);
		return m ? m[1].length : 0;
	} catch {
		return 0;
	}
}

/** A "Process/Steps/Flow/Workflow" H2 with a numbered list is a strong signal the entry is read
 * start-to-finish every invocation, not branched into — raw token count can't tell a pipeline
 * apart from a genuine dispatcher. */
export function isPipelineShaped(text: string): boolean {
	return /^##\s+(Process|Steps|Flow|Workflow)\b/im.test(text) && /^\d+\.\s/m.test(text);
}

/** H2 headings cited elsewhere in the same file via "above"/"below" are core control-flow content
 * an orchestrator re-reads every run, not situational detail — token count alone can't see this. */
export function backReferencedHeadings(text: string): string[] {
	const headings = [...text.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim());
	const flagged: string[] = [];
	for (const heading of headings) {
		const stripped = heading
			.replace(/\(.*/, "")
			.replace(/[^a-zA-Z0-9 ]/g, "")
			.trim();
		const words = stripped.split(/\s+/).filter((w) => w.length >= 4);
		if (words.length === 0) continue;
		const keyword = words.sort((a, b) => b.length - a.length)[0];
		const re = new RegExp(
			`\\b${keyword}\\b[^\\n]{0,60}\\b(above|below)\\b|\\b(above|below)\\b[^\\n]{0,60}\\b${keyword}\\b`,
			"i",
		);
		if (re.test(text)) flagged.push(heading);
	}
	return flagged;
}

export function audit(skillDir: string, threshold = 1500, doFix = false): Audit | null {
	const dir = skillDir.replace(/\/$/, "");
	const name = dir.split("/").pop();
	if (!name) return null;
	const files: FileEntry[] = [];
	const junkFull: string[] = [];
	const vendor = { v: false };
	try {
		walk(dir, dir, files, junkFull, vendor);
	} catch {
		return null;
	}
	if (files.length === 0 && junkFull.length === 0) return null;

	const issues: string[] = [];
	const fixed: string[] = [];

	const lowercaseEntry = files.find((f) => f.path === "skill.md");
	if (lowercaseEntry) {
		if (doFix) {
			renameSync(join(dir, "skill.md"), join(dir, "SKILL.md"));
			lowercaseEntry.path = "SKILL.md";
			fixed.push("renamed skill.md → SKILL.md");
		} else {
			issues.push("top-level skill.md is lowercase — not discoverable; rename to SKILL.md");
		}
	}
	for (const j of junkFull) {
		if (doFix) {
			unlinkSync(j);
			fixed.push(`deleted ${relative(dir, j)}`);
		} else {
			issues.push(`junk file: ${relative(dir, j)}`);
		}
	}
	for (const e of files.filter((f) => f.isEntryPoint)) {
		if (e.tokens <= threshold) continue;
		const text = readFileSync(join(dir, e.path), "utf8");
		const coreRefs = backReferencedHeadings(text);
		const note =
			coreRefs.length > 0
				? ` — back-referenced inline (${coreRefs.join(", ")}); likely core content the orchestrator re-reads every invocation, not situational — verify before moving`
				: isPipelineShaped(text)
					? " — pipeline-shaped (sequential Process/Steps read every invocation); large sections here may still be core, not just situational"
					: "";
		issues.push(`${e.path} ≈${e.tokens} tok exceeds ${threshold} — restructure candidate${note}`);
	}
	for (const b of brokenLinks(dir, files)) issues.push(`broken link: ${b}`);
	const descLen = descriptionLength(dir);
	if (descLen > DESC_LIMIT) {
		issues.push(`frontmatter description is ${descLen} chars (>${DESC_LIMIT}) — loads every session, trim it`);
	}

	return {
		skill: name,
		dir,
		vendor: vendor.v,
		totalTokens: files.reduce((s, f) => s + f.tokens, 0),
		files,
		issues,
		fixed,
		junk: junkFull.map((j) => relative(dir, j)),
	};
}
