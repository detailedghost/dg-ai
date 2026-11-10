import { existsSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseYaml, splitDocument } from "../spec/frontmatter";

const SKIP_DIRS = new Set(["node_modules", ".git", "examples"]);
const JUNK = [/Zone\.Identifier$/, /\.DS_Store$/, /Thumbs\.db$/];
const DESC_LIMIT = 500;
const SCAN_RE = /~~~[\s\S]*?~~~|```[\s\S]*?```|`[^`]*`|\[[^\]]*\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/g;

export const approxTokens = (n: number) => Math.round(n / 4);

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

function walk(dir: string, root: string, out: FileEntry[], junk: string[], vendor: { v: boolean }) {
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

/** Relative `[text](a/b.md)` links outside code that resolve from no ancestor up to the skills root. */
export function brokenLinks(root: string, files: FileEntry[]): string[] {
	const out: string[] = [];
	const skillRoot = resolve(root);
	const skillsRoot = dirname(skillRoot);
	for (const f of files) {
		const text = readFileSync(join(skillRoot, f.path), "utf8");
		const seen = new Set<string>();
		for (const m of text.matchAll(SCAN_RE)) {
			const href = m[1];
			if (!href || href.startsWith("http") || href.startsWith("~") || !href.includes("/")) continue;
			if (seen.has(href)) continue;
			seen.add(href);
			const bases: string[] = [];
			for (let d = dirname(join(skillRoot, f.path)); d.startsWith(skillsRoot + sep); d = dirname(d)) bases.push(d);
			bases.push(skillsRoot);
			if (!bases.some((b) => existsSync(join(b, href)))) out.push(`${f.path} → ${href}`);
		}
	}
	return out;
}

function descriptionLength(root: string): number {
	const entry = join(root, "SKILL.md");
	if (!existsSync(entry)) return 0;
	const parsed = parseYaml(splitDocument(readFileSync(entry, "utf8")).front);
	const value = parsed.ok ? (parsed.value as { description?: unknown } | null)?.description : undefined;
	return typeof value === "string" ? value.length : 0;
}

/** A Process/Steps/Flow/Workflow H2 plus a numbered list marks an entry read start to finish. */
export function isPipelineShaped(text: string): boolean {
	return /^##\s+(Process|Steps|Flow|Workflow)\b/im.test(text) && /^\d+\.\s/m.test(text);
}

/** The most distinctive word of an H2 heading, used to spot "above"/"below" prose about it. */
export function headingKeyword(heading: string): string | undefined {
	const stripped = heading
		.replace(/\(.*/, "")
		.replace(/[^a-zA-Z0-9 ]/g, "")
		.trim();
	const words = stripped.split(/\s+/).filter((w) => w.length >= 4);
	return words.sort((a, b) => b.length - a.length)[0];
}

export function nearAboveBelow(keyword: string): RegExp {
	return new RegExp(
		`\\b${keyword}\\b[^\\n]{0,60}\\b(above|below)\\b|\\b(above|below)\\b[^\\n]{0,60}\\b${keyword}\\b`,
		"i",
	);
}

/** H2 headings the same file cites with "above"/"below", which mark core content. */
export function backReferencedHeadings(text: string): string[] {
	const headings = [...text.matchAll(/^##\s+(.+)$/gm)].map((m) => (m[1] ?? "").trim());
	return headings.filter((heading) => {
		const keyword = headingKeyword(heading);
		return keyword !== undefined && nearAboveBelow(keyword).test(text);
	});
}

export function audit(skillDir: string, threshold = 1500, doFix = false): Audit | null {
	const dir = resolve(skillDir);
	const files: FileEntry[] = [];
	const junkFull: string[] = [];
	const vendor = { v: false };
	walk(dir, dir, files, junkFull, vendor);
	if (files.length === 0 && junkFull.length === 0) return null;

	const issues: string[] = [];
	const fixed: string[] = [];

	const lowercaseEntry = files.find((f) => f.path === "skill.md");
	const bothEntries = lowercaseEntry !== undefined && readdirSync(dir).includes("SKILL.md");
	if (bothEntries) {
		issues.push("both SKILL.md and skill.md exist — merge them by hand; --fix will not overwrite SKILL.md");
	} else if (lowercaseEntry) {
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
	if (descLen > DESC_LIMIT)
		issues.push(`frontmatter description is ${descLen} chars (>${DESC_LIMIT}) — loads every session, trim it`);

	return {
		skill: dir.split("/").pop() ?? dir,
		dir,
		vendor: vendor.v,
		totalTokens: files.reduce((s, f) => s + f.tokens, 0),
		files,
		issues,
		fixed,
		junk: junkFull.map((j) => relative(dir, j)),
	};
}

export function formatAudit(r: Audit): string[] {
	const tag = r.vendor ? " [vendor]" : "";
	const entries = r.files.filter((f) => f.isEntryPoint);
	const refs = r.files.filter((f) => !f.isEntryPoint).sort((a, b) => b.tokens - a.tokens);
	const epTok = entries.reduce((s, f) => s + f.tokens, 0);
	const lines = [
		`\n## ${r.skill}${tag} — EP ≈${epTok} tok  (+${r.totalTokens - epTok} on-demand, ${refs.length} refs)`,
	];
	for (const e of entries) lines.push(`  entry  ${e.path.padEnd(40)} ≈${e.tokens} tok`);
	for (const f of refs.slice(0, 8)) lines.push(`  ref    ${f.path.padEnd(40)} ≈${f.tokens} tok`);
	if (refs.length > 8) lines.push(`  …and ${refs.length - 8} smaller reference files`);
	for (const fx of r.fixed) lines.push(`  ✔ ${fx}`);
	for (const i of r.issues) lines.push(`  ⚠ ${i}`);
	return lines;
}
