import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { projectHash, repoRoot, stateRoot } from "@dg/common/node";
import { die, EXIT, type SubcommandSpec } from "../utils/legacy-command";

const TERM_SECTIONS = [
	"Domain Terms",
	"Naming Conventions",
	"Architectural Patterns",
	"Concepts",
] as const;
const TERM_SECTIONS_SET = new Set<string>(TERM_SECTIONS);

const SOFT_CAP_ROWS_PER_SECTION = 40;
const SOFT_CAP_TOTAL_BYTES = 6144;
const EXIT_OVER_CAP = 2;

const CONTAINER_DIRS = new Set([
	"pkg",
	"pkgs",
	"packages",
	"apps",
	"services",
	"libs",
	"crates",
	"modules",
	"projects",
]);
const MIN_ROWS_PER_DOMAIN = 3;
const GENERAL_DOMAIN = "general";

const DEFAULT_AGENTS_REL = ".agents";
const DEFAULT_MONOLITH_REL = "monolith.md";

const AGENTS_MD_POINTER_LINE =
	"- [Vocabulary](monolith.md) -- project-specific terminology; consult before naming things.";

function requireFile(p: string): void {
	if (!existsSync(p) || !statSync(p).isFile()) die(`file not found: ${p}`);
}

function abspath(p: string): string {
	return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

function slugify(s: string): string {
	return s
		.toLowerCase()
		.replace(/[ ]/g, "_")
		.replace(/[^a-z0-9_]/g, "");
}

function stripMarkdownEscapes(term: string): string {
	return term
		.replace(/\\</g, "<")
		.replace(/\\>/g, ">")
		.replace(/\\_/g, "_")
		.replace(/\\\*/g, "*")
		.replace(/\\`/g, "`");
}

function extractBoldTerm(line: string): string | null {
	const i = line.indexOf("**");
	if (i === -1) return null;
	const rest = line.slice(i + 2);
	const j = rest.indexOf("**");
	if (j === -1) return null;
	const raw = rest.slice(0, j).trim();
	return raw ? stripMarkdownEscapes(raw) : null;
}

function isTermRow(line: string): boolean {
	if (!line.startsWith("|")) return false;
	if (/^\|[-| :]+\|\s*$/.test(line)) return false;
	if (!line.includes("**")) return false;
	return true;
}

function listTermsInSection(content: string, sectionFilter: string): string[] {
	const terms: string[] = [];
	let inSection = false;

	for (const line of content.split("\n")) {
		if (line.startsWith("## ")) {
			const heading = line.slice(3).trimEnd();
			if (sectionFilter !== "") {
				inSection = heading === sectionFilter;
			} else {
				inSection = TERM_SECTIONS_SET.has(heading);
			}
			continue;
		}
		if (!inSection) continue;
		if (!isTermRow(line)) continue;
		const term = extractBoldTerm(line);
		if (term) terms.push(term);
	}

	return terms;
}

function listSections(content: string): string[] {
	return content
		.split("\n")
		.filter((l) => l.startsWith("## "))
		.map((l) => l.slice(3).trimEnd());
}

const DOMAIN_INDEX_SECTION = "Vocabulary by domain";

function isDomainIndex(content: string): boolean {
	return listSections(content).includes(DOMAIN_INDEX_SECTION);
}

function resolveVocabularyFiles(file: string): {
	files: string[];
	projectRoot: string;
	split: boolean;
} {
	const abs = abspath(file);
	const content = readFileSync(abs, "utf8");
	const projectRoot = path.dirname(path.dirname(abs));

	if (!isDomainIndex(content))
		return { files: [abs], projectRoot, split: false };

	const files: string[] = [];
	let inIndex = false;
	for (const line of content.split("\n")) {
		if (line.startsWith("## ")) {
			inIndex = line.slice(3).trimEnd() === DOMAIN_INDEX_SECTION;
			continue;
		}
		if (!inIndex || !line.startsWith("|")) continue;
		const link = line.match(/\]\(([^)]+)\)/);
		if (!link) continue;
		const resolved = path.resolve(path.dirname(abs), link[1]);
		if (existsSync(resolved)) files.push(resolved);
	}

	if (files.length === 0) {
		process.stderr.write(
			`warn: ${path.basename(abs)} indexes no readable domain files\n`,
		);
		return { files: [abs], projectRoot, split: false };
	}
	return { files, projectRoot, split: true };
}

function cmdBootstrap(args: string[]): number {
	let dir = ".";
	let light = false;

	for (const a of args) {
		if (a === "--shallow" || a === "-s") {
			light = true;
		} else if (!a.startsWith("-")) {
			dir = a;
		} else {
			die(`bootstrap: unknown flag: ${a} (did you mean --shallow?)`);
		}
	}

	if (light) {
		const origin = repoRoot();
		const slug = origin ? path.basename(origin) : "anonymous";
		const lightDir = path.join(stateRoot(), "monolith", projectHash(), slug);
		mkdirSync(lightDir, { recursive: true });
		const monolithPath = path.join(lightDir, "monolith.md");

		process.stdout.write(
			`APPEND_MODE=${existsSync(monolithPath) ? "1" : "0"}\n`,
		);
		process.stdout.write(`MONOLITH_PATH=${monolithPath}\n`);
		process.stdout.write("LIGHT_MODE=1\n");
		process.stdout.write(`LIGHT_DIR=${lightDir}\n`);
		process.stdout.write(`ORIGIN_REPO=${origin ?? ""}\n`);
		process.stdout.write(`SLUG=${slug}\n`);
		return EXIT.OK;
	}

	const resolved = path.resolve(dir);
	if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
		die(`directory not found: ${dir}`);
	}

	const agentsDir = path.join(resolved, DEFAULT_AGENTS_REL);
	mkdirSync(agentsDir, { recursive: true });
	const monolithPath = path.join(agentsDir, DEFAULT_MONOLITH_REL);

	process.stdout.write(`APPEND_MODE=${existsSync(monolithPath) ? "1" : "0"}\n`);
	process.stdout.write(`MONOLITH_PATH=${abspath(monolithPath)}\n`);
	process.stdout.write("LIGHT_MODE=0\n");
	return EXIT.OK;
}

function cmdListTerms(args: string[]): number {
	const [file, section = ""] = args;
	if (!file) die("list-terms: FILE required");
	requireFile(file);
	const { files } = resolveVocabularyFiles(file);
	const terms = files.flatMap((f) =>
		listTermsInSection(readFileSync(f, "utf8"), section),
	);
	if (terms.length) process.stdout.write(`${terms.join("\n")}\n`);
	return EXIT.OK;
}

function cmdListSections(args: string[]): number {
	const [file] = args;
	if (!file) die("list-sections: FILE required");
	requireFile(file);
	const { files } = resolveVocabularyFiles(file);
	const sections = [
		...new Set(files.flatMap((f) => listSections(readFileSync(f, "utf8")))),
	];
	if (sections.length) process.stdout.write(`${sections.join("\n")}\n`);
	return EXIT.OK;
}

function cmdValidate(args: string[]): number {
	const [file] = args;
	if (!file) die("validate: FILE required");
	requireFile(file);

	const { files, split } = resolveVocabularyFiles(file);
	let ok = true;

	const haveSections = new Set<string>();
	const allTerms: string[] = [];
	for (const f of files) {
		const content = readFileSync(f, "utf8");
		for (const heading of listSections(content)) haveSections.add(heading);
		allTerms.push(...listTermsInSection(content, ""));
	}

	for (const req of TERM_SECTIONS) {
		if (!haveSections.has(req)) {
			process.stderr.write(
				`validate: missing required section: ${req}${split ? " (across every domain file)" : ""}\n`,
			);
			ok = false;
		}
	}

	const seen = new Map<string, number>();
	for (const t of allTerms) seen.set(t, (seen.get(t) ?? 0) + 1);
	const dups = [...seen.entries()].filter(([, n]) => n > 1).map(([t]) => t);
	if (dups.length) {
		process.stderr.write(
			`validate: duplicate term(s) found:\n${dups.join("\n")}\n`,
		);
		ok = false;
	}

	return ok ? EXIT.OK : EXIT.ERR;
}

function pruneOneFile(
	file: string,
	projectRoot: string,
	dry: boolean,
): Array<{ term: string; src: string }> {
	const kept: string[] = [];
	const removed: Array<{ term: string; src: string }> = [];
	let inTermSection = false;

	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (line.startsWith("## ")) {
			inTermSection = TERM_SECTIONS_SET.has(line.slice(3).trimEnd());
			kept.push(line);
			continue;
		}

		if (!inTermSection || !isTermRow(line)) {
			kept.push(line);
			continue;
		}

		const srcPath = extractSrcPath(line);
		if (srcPath === "") {
			kept.push(line);
			continue;
		}

		const resolved = path.isAbsolute(srcPath)
			? srcPath
			: path.join(projectRoot, srcPath);
		if (existsSync(resolved)) {
			kept.push(line);
		} else {
			removed.push({ term: extractBoldTerm(line) ?? "?", src: srcPath });
		}
	}

	if (!dry && removed.length > 0) writeFileSync(file, kept.join("\n"));
	return removed;
}

function cmdPrune(args: string[]): number {
	const file = args[0];
	const dry = args.includes("--dry-run");

	if (!file) die("prune: FILE required");
	requireFile(file);

	const { files: layout, projectRoot } = resolveVocabularyFiles(file);

	for (const f of layout) {
		for (const { term, src } of pruneOneFile(f, projectRoot, dry)) {
			process.stdout.write(`${term}\t${src}\n`);
		}
	}

	return EXIT.OK;
}

function cmdPatchPointer(args: string[]): number {
	const [file] = args;
	if (!file) die("patch-pointer: FILE required");
	requireFile(file);

	const content = readFileSync(file, "utf8");

	if (content.includes("(monolith.md)")) {
		return EXIT.OK;
	}

	let out: string;

	if (content.split("\n").some((l) => l === "## References")) {
		const lines = content.split("\n");
		const result: string[] = [];
		let done = false;
		let i = 0;
		while (i < lines.length) {
			const l = lines[i];
			result.push(l);
			if (!done && l === "## References") {
				i++;
				const nextLine = lines[i] ?? "";
				result.push(nextLine);
				if (nextLine === "") {
					result.push(AGENTS_MD_POINTER_LINE);
				} else {
					result.push(AGENTS_MD_POINTER_LINE);
					result.push("");
				}
				done = true;
				i++;
				continue;
			}
			i++;
		}
		out = result.join("\n");
	} else {
		out = `${content.trimEnd()}\n\n## References\n\n${AGENTS_MD_POINTER_LINE}\n`;
	}

	writeFileSync(file, out);
	return EXIT.OK;
}

function extractSrcPath(line: string): string {
	const srcIdx = line.indexOf("_src:_");
	if (srcIdx === -1) return "";
	const tail = line.slice(srcIdx + "_src:_".length).trimStart();
	const pipePos = tail.indexOf("|");
	return (pipePos > -1 ? tail.slice(0, pipePos) : tail).trimEnd();
}

function kebab(s: string): string {
	return s
		.replace(/^\.+/, "")
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function domainForSrc(srcPath: string): string {
	if (!srcPath) return GENERAL_DOMAIN;
	const segments = srcPath
		.replace(/^\.\//, "")
		.split("/")
		.filter((seg) => seg !== "" && seg !== ".");
	if (segments.length === 0) return GENERAL_DOMAIN;

	let head = segments[0];
	if (CONTAINER_DIRS.has(head.toLowerCase()) && segments.length > 1)
		head = segments[1];
	if (segments.length === 1 && head.includes(".") && !head.startsWith("."))
		return GENERAL_DOMAIN;

	return kebab(head) || GENERAL_DOMAIN;
}

type DomainRow = { section: string; line: string };

function splitPreamble(content: string): { preamble: string; body: string } {
	const lines = content.split("\n");
	const firstGenerated = lines.findIndex((l) => {
		if (!l.startsWith("## ")) return false;
		const heading = l.slice(3).trimEnd();
		return TERM_SECTIONS_SET.has(heading) || heading === DOMAIN_INDEX_SECTION;
	});
	if (firstGenerated === -1) return { preamble: content, body: "" };
	return {
		preamble: lines.slice(0, firstGenerated).join("\n").trimEnd(),
		body: lines.slice(firstGenerated).join("\n"),
	};
}

function sectionHeader(content: string, section: string): string[] {
	const lines = content.split("\n");
	let inSection = false;
	const header: string[] = [];
	for (const line of lines) {
		if (line.startsWith("## ")) {
			if (inSection) break;
			inSection = line.slice(3).trimEnd() === section;
			continue;
		}
		if (!inSection) continue;
		if (line.startsWith("|") && !isTermRow(line)) header.push(line);
		if (header.length === 2) break;
	}
	return header.length === 2
		? header
		: ["| Term | Definition |", "|------|------------|"];
}

function nonTermSections(content: string): string {
	const lines = content.split("\n");
	const out: string[] = [];
	let keeping = false;
	for (const line of lines) {
		if (line.startsWith("## ")) {
			const heading = line.slice(3).trimEnd();
			keeping =
				!TERM_SECTIONS_SET.has(heading) && heading !== "Vocabulary by domain";
			if (keeping) out.push(line);
			continue;
		}
		if (keeping) out.push(line);
	}
	return out.join("\n").trim();
}

function cmdSplit(args: string[]): number {
	let file = "";
	let outDir = "";
	let minRows = MIN_ROWS_PER_DOMAIN;
	let dry = false;

	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--dry-run") dry = true;
		else if (a === "--out-dir")
			outDir = args[++i] ?? die("split: --out-dir needs a path");
		else if (a === "--min-rows")
			minRows = Number(args[++i] ?? die("split: --min-rows needs a number"));
		else if (!a.startsWith("-") && file === "") file = a;
		else die(`split: unknown flag: ${a}`);
	}

	if (!file) die("split: FILE required");
	requireFile(file);
	if (!Number.isInteger(minRows) || minRows < 1)
		die("split: --min-rows must be a positive integer");

	const abs = abspath(file);
	const content = readFileSync(abs, "utf8");
	const target = outDir
		? abspath(outDir)
		: path.join(path.dirname(abs), path.basename(abs).replace(/\.md$/, ""));

	const { files: sources } = resolveVocabularyFiles(abs);
	const absorbed = sources.includes(abs)
		? [content]
		: [content, ...sources.map((f) => readFileSync(f, "utf8"))];
	const stale = sources.filter((f) => f !== abs);

	const byDomain = new Map<string, DomainRow[]>();
	for (const source of absorbed) {
		let section = "";
		for (const line of source.split("\n")) {
			if (line.startsWith("## ")) {
				const heading = line.slice(3).trimEnd();
				section = TERM_SECTIONS_SET.has(heading) ? heading : "";
				continue;
			}
			if (!section || !isTermRow(line)) continue;
			const domain = domainForSrc(extractSrcPath(line));
			const rows = byDomain.get(domain) ?? [];
			rows.push({ section, line });
			byDomain.set(domain, rows);
		}
	}

	if (byDomain.size === 0) die("split: no term rows found");

	const general = byDomain.get(GENERAL_DOMAIN) ?? [];
	for (const [domain, rows] of [...byDomain]) {
		if (domain === GENERAL_DOMAIN) continue;
		if (rows.length < minRows) {
			general.push(...rows);
			byDomain.delete(domain);
		}
	}
	if (general.length > 0) byDomain.set(GENERAL_DOMAIN, general);

	if (byDomain.size < 2) {
		process.stderr.write(
			`split: every row lands in one domain (${[...byDomain.keys()][0]}); splitting would gain nothing\n`,
		);
		return EXIT.ERR;
	}

	const domains = [...byDomain.keys()].sort((a, b) =>
		a === GENERAL_DOMAIN ? 1 : b === GENERAL_DOMAIN ? -1 : a.localeCompare(b),
	);
	const { preamble } = splitPreamble(content);
	const written: Array<{
		domain: string;
		rel: string;
		rows: number;
		bytes: number;
	}> = [];

	for (const domain of domains) {
		const rows = byDomain.get(domain) ?? [];
		const parts = [
			`# Project Vocabulary — ${domain}`,
			"<!-- Generated by /monolith split. One domain per file. -->",
		];

		for (const sec of TERM_SECTIONS) {
			const inSection = rows.filter((r) => r.section === sec);
			if (inSection.length === 0) continue;
			parts.push(
				"",
				`## ${sec}`,
				"",
				...sectionHeader(content, sec),
				...inSection.map((r) => r.line),
			);
		}

		const body = `${parts.join("\n")}\n`;
		const rel = path.join(path.basename(target), `${domain}.md`);
		written.push({
			domain,
			rel,
			rows: rows.length,
			bytes: Buffer.byteLength(body, "utf8"),
		});
		if (!dry) {
			mkdirSync(target, { recursive: true });
			writeFileSync(path.join(target, `${domain}.md`), body);
		}
	}

	const index = [
		preamble || "# Project Vocabulary",
		"",
		"## Vocabulary by domain",
		"",
		"| Domain | File | Terms |",
		"|--------|------|-------|",
		...written.map((w) => `| ${w.domain} | [${w.rel}](${w.rel}) | ${w.rows} |`),
	];
	const trailing = nonTermSections(content);
	if (trailing) index.push("", trailing);
	const indexBody = `${index.join("\n").trimEnd()}\n`;

	if (dry) {
		for (const w of written)
			process.stdout.write(`${w.domain}\t${w.rel}\t${w.rows}\t${w.bytes}\n`);
		process.stdout.write(
			`index\t${path.basename(abs)}\t0\t${Buffer.byteLength(indexBody, "utf8")}\n`,
		);
		return EXIT.OK;
	}

	const keep = new Set(written.map((w) => path.join(target, `${w.domain}.md`)));
	for (const f of stale) {
		if (!keep.has(f)) rmSync(f);
	}

	writeFileSync(abs, indexBody);

	const over = written.filter((w) => w.bytes > SOFT_CAP_TOTAL_BYTES);
	for (const w of written)
		process.stdout.write(`DOMAIN_${slugify(w.domain)}=${w.rows}:${w.bytes}\n`);
	process.stdout.write(`INDEX_BYTES=${Buffer.byteLength(indexBody, "utf8")}\n`);
	if (over.length > 0) {
		process.stderr.write(
			`split: still over the ${SOFT_CAP_TOTAL_BYTES}-byte cap: ${over.map((w) => w.domain).join(", ")}\n`,
		);
		return EXIT_OVER_CAP;
	}
	return EXIT.OK;
}

function cmdCapReport(args: string[]): number {
	const [file] = args;
	if (!file) die("cap-report: FILE required");
	requireFile(file);

	const { files, split } = resolveVocabularyFiles(file);
	let exitCode: number = EXIT.OK;
	let overBytes = false;

	let widest = 0;
	for (const f of files) {
		const fileBytes = Buffer.byteLength(readFileSync(f, "utf8"), "utf8");
		widest = Math.max(widest, fileBytes);
		if (split)
			process.stdout.write(
				`FILE_BYTES_${slugify(path.basename(f, ".md"))}=${fileBytes}\n`,
			);
		if (fileBytes > SOFT_CAP_TOTAL_BYTES) overBytes = true;
	}
	process.stdout.write(`TOTAL_BYTES=${widest}\n`);
	if (split) process.stdout.write(`DOMAIN_FILES=${files.length}\n`);

	const merged = files.map((f) => readFileSync(f, "utf8")).join("\n");
	for (const section of TERM_SECTIONS) {
		const count = listTermsInSection(merged, section).length;
		process.stdout.write(`SECTION_ROWS_${slugify(section)}=${count}\n`);
		if (!split && count > SOFT_CAP_ROWS_PER_SECTION) exitCode = EXIT.ERR;
	}

	if (overBytes && exitCode === EXIT.OK) exitCode = EXIT_OVER_CAP;

	return exitCode;
}

function cmdDetectConflicts(args: string[]): number {
	const [oldFile, newFile] = args;
	if (!oldFile) die("detect-conflicts: OLD_FILE required");
	if (!newFile) die("detect-conflicts: NEW_FILE required");
	requireFile(oldFile);
	requireFile(newFile);

	type TermRow = { section: string; row: string };

	function dumpTerms(content: string): Map<string, TermRow> {
		const map = new Map<string, TermRow>();
		let currentSection = "";
		for (const line of content.split("\n")) {
			if (line.startsWith("## ")) {
				const heading = line.slice(3).trimEnd();
				currentSection = TERM_SECTIONS_SET.has(heading) ? heading : "";
				continue;
			}
			if (!currentSection || !isTermRow(line)) continue;
			const term = extractBoldTerm(line);
			if (!term) continue;
			map.set(term, { section: currentSection, row: line });
		}
		return map;
	}

	const oldTerms = dumpTerms(readFileSync(oldFile, "utf8"));
	const newTerms = dumpTerms(readFileSync(newFile, "utf8"));

	for (const [term, oldEntry] of oldTerms) {
		const newEntry = newTerms.get(term);
		if (!newEntry) continue;
		if (oldEntry.row !== newEntry.row) {
			process.stdout.write(
				`${oldEntry.section}\t${term}\t${oldEntry.row}\t${newEntry.row}\n`,
			);
		}
	}

	return EXIT.OK;
}

function cmdApplyConflictResolution(args: string[]): number {
	const [staging, conflictsTsv, logPath] = args;
	if (!staging) die("apply-conflict-resolution: STAGING required");
	if (!conflictsTsv) die("apply-conflict-resolution: CONFLICTS_TSV required");
	if (!logPath) die("apply-conflict-resolution: LOG_PATH required");
	requireFile(staging);
	requireFile(conflictsTsv);

	const conflictsRaw = readFileSync(conflictsTsv, "utf8").trim();
	if (!conflictsRaw) return EXIT.OK;

	const conflicts = conflictsRaw.split("\n").flatMap((line) => {
		const parts = line.split("\t");
		if (parts.length < 4) return [];
		const [section, term, oldRow, newRow] = parts;
		return [{ section, term, oldRow, newRow }];
	});

	if (!conflicts.length) return EXIT.OK;

	mkdirSync(path.dirname(logPath), { recursive: true });

	if (!existsSync(logPath)) {
		writeFileSync(
			logPath,
			"# Monolith Conflicts Log\n\n" +
				"<!-- Auto-generated by /monolith in non-interactive mode.\n" +
				"     Each entry preserves the existing row and the rejected new\n" +
				"     candidate so a human can resolve later. -->\n\n",
		);
	}

	const ts = new Date()
		.toISOString()
		.replace("T", " ")
		.replace(/\.\d+Z$/, "");

	let logEntry = `## ${ts}\n\n`;
	const oldForTerm = new Map<string, string>();

	for (const { section, term, oldRow, newRow } of conflicts) {
		oldForTerm.set(term, oldRow);
		logEntry += `- **${term}** (${section})\n`;
		logEntry += `  - kept (existing): \`${oldRow}\`\n`;
		logEntry += `  - rejected (new):  \`${newRow}\`\n`;
	}
	logEntry += "\n";

	const existing = readFileSync(logPath, "utf8");
	writeFileSync(logPath, existing + logEntry);

	const stagingLines = readFileSync(staging, "utf8").split("\n");
	const result = stagingLines.map((line) => {
		if (!line.includes("**")) return line;
		const term = extractBoldTerm(line);
		return (term ? oldForTerm.get(term) : undefined) ?? line;
	});

	writeFileSync(staging, result.join("\n"));
	return EXIT.OK;
}

/** Terms of a vocabulary index or domain file. */
export function listVocabularyTerms(file: string): string[] {
	const { files } = resolveVocabularyFiles(file);
	return files.flatMap((f) => listTermsInSection(readFileSync(f, "utf8"), ""));
}

const sync = (run: (args: string[]) => number) => async (args: string[]) =>
	run(args);

/** Helper verbs of the monolith command, in legacy help order. */
export const HELPER_VERBS: Record<string, SubcommandSpec> = {
	bootstrap: {
		description: "Bootstrap .agents/ dir and emit shell-eval vars",
		run: sync(cmdBootstrap),
	},
	"list-terms": {
		description: "List term names from a monolith.md",
		args: ["FILE", "[SECTION]"],
		run: sync(cmdListTerms),
	},
	"list-sections": {
		description: "List ## section headings in FILE",
		args: ["FILE"],
		run: sync(cmdListSections),
	},
	validate: {
		description: "Validate a monolith.md",
		args: ["FILE"],
		run: sync(cmdValidate),
	},
	prune: {
		description: "Remove rows with missing _src:_ paths",
		args: ["FILE"],
		run: sync(cmdPrune),
	},
	"patch-pointer": {
		description: "Idempotently link FILE to monolith.md",
		args: ["FILE"],
		run: sync(cmdPatchPointer),
	},
	"patch-agents-md": {
		description: "Alias for patch-pointer",
		args: ["FILE"],
		run: sync(cmdPatchPointer),
	},
	"cap-report": {
		description: "Print byte/row counts; exits 1 or 2 at soft caps",
		args: ["FILE"],
		run: sync(cmdCapReport),
	},
	split: {
		description:
			"Split FILE into one file per domain and leave an index behind",
		args: ["FILE", "[--out-dir DIR]", "[--min-rows N]", "[--dry-run]"],
		run: sync(cmdSplit),
	},
	"detect-conflicts": {
		description: "Print TSV conflict lines between two monolith.md files",
		args: ["OLD_FILE", "NEW_FILE"],
		run: sync(cmdDetectConflicts),
	},
	"apply-conflict-resolution": {
		description: "Restore existing rows for conflicts; append log",
		args: ["STAGING", "CONFLICTS_TSV", "LOG_PATH"],
		run: sync(cmdApplyConflictResolution),
	},
};
