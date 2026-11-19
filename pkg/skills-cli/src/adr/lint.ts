import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { die, say } from "../spec/shared";
import { frontOf } from "../utils/frontmatter";
import { git, remoteDefaultBranch } from "../utils/git";
import { indexTail, renderIndexes } from "./index-gen";
import { gradeLimit, isLevel, LEVELS, parseLevel, type Level } from "./levels";
import { ADR_DIR, DECISION_DIR, README_FILE, repoRoot, requireInitialized, TOC_FILE } from "./paths";
import { gradeOf, HEADING, outsideFences, scanFences } from "./readability";
import { type AdrRecord, loadRecords, matchCovers, normalizePath, repoLevel } from "./records";
import { HUMAN_SECTIONS, TOC_MARKER } from "./templates";

const MAX_GRADE_BYTES = 1_000_000;

const USAGE = "usage: dg-skills adr lint (--all | --changed [--base <ref>] | --grade <file|->) [--level <l>] [--json]";

interface Finding {
	file: string;
	rule: string;
	message: string;
	grade?: number;
	limit?: number | null;
}

type Mode = "--all" | "--changed" | "--grade";

interface Options {
	modes: Mode[];
	json: boolean;
	base?: string;
	grade?: string;
	level?: string;
}

interface Context {
	root: string;
	level: Level;
	adrCount: Map<string, number>;
	decisionCount: Map<string, number>;
}

function parseOptions(args: string[]): Options {
	const options: Options = { modes: [], json: false };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--all" || arg === "--changed") options.modes.push(arg);
		else if (arg === "--json") options.json = true;
		else if (arg === "--base" || arg === "--grade" || arg === "--level") {
			const value = args[++i];
			if (value === undefined) die(USAGE);
			if (arg === "--grade") {
				options.modes.push(arg);
				options.grade = value;
			} else if (arg === "--base") options.base = value;
			else options.level = value;
		} else die(USAGE);
	}
	if (options.base !== undefined && (!options.modes.includes("--changed") || options.base.startsWith("-"))) die(USAGE);
	if (options.level !== undefined && !options.modes.includes("--grade")) die(USAGE);
	return options;
}

function echo(value: string): string {
	return JSON.stringify(value.slice(0, 40).replace(/[^\w./#-]/g, "?"));
}

function round1(value: number): number {
	return Math.round(value * 10) / 10;
}

function headingsOf(text: string): string[] {
	return outsideFences(text)
		.map((line) => line.match(HEADING)?.[1]?.trim().replace(/#+$/, "").trim())
		.filter((heading): heading is string => heading !== undefined && heading !== "");
}

function linkTargets(text: string): string[] {
	const prose = outsideFences(text).join("\n").replace(/`[^`]*`/g, " ");
	return [...prose.matchAll(/\[[^\][]{0,500}\]\(([^)\s]{1,500})(?:\s+"[^")]{0,500}")?\)/g)].map((match) => match[1] ?? "");
}

function anchorOf(heading: string): string {
	return heading.toLowerCase().replace(/[^\p{L}\p{N}_\s-]/gu, "").trim().replaceAll(" ", "-");
}

function anchorsOf(text: string): Set<string> {
	const seen = new Map<string, number>();
	const anchors = new Set<string>();
	for (const heading of headingsOf(text)) {
		const base = anchorOf(heading);
		const count = seen.get(base) ?? 0;
		seen.set(base, count + 1);
		anchors.add(count === 0 ? base : `${base}-${count}`);
	}
	return anchors;
}

function decodePart(part: string): string {
	try {
		return decodeURIComponent(part);
	} catch {
		return part;
	}
}

function targetPath(target: string, from: string, root: string): string {
	const filePart = decodePart(target.split(/[#?]/)[0] ?? "");
	return resolve(filePart.startsWith("/") ? root : dirname(from), filePart.replace(/^\/+/, ""));
}

function brokenLinks(path: string, text: string, root: string): Finding[] {
	const anchors = anchorsOf(text);
	const file = normalizePath(path, root);
	const found: Finding[] = [];
	for (const target of linkTargets(text)) {
		if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
		if (target.startsWith("#")) {
			if (!anchors.has(target.slice(1))) found.push({ file, rule: "broken-link", message: `anchor ${echo(target)} matches no heading` });
			continue;
		}
		const filePart = decodePart(target.split(/[#?]/)[0] ?? "");
		if (filePart !== "" && !existsSync(targetPath(target, path, root))) found.push({ file, rule: "broken-link", message: `link target ${echo(target)} does not exist` });
	}
	return found;
}

function diagramHasMermaid(text: string): boolean {
	const lines = scanFences(text);
	const start = lines.findIndex((entry) => entry.kind === "text" && /^## Diagram[ \t]*$/.test(entry.line));
	if (start < 0) return false;
	const rest = lines.slice(start + 1);
	const end = rest.findIndex((entry) => entry.kind === "text" && entry.line.startsWith("## "));
	const section = end < 0 ? rest : rest.slice(0, end);
	const open = section.findIndex((entry) => entry.kind === "open" && /^\s*(?:`{3,}|~{3,})\s*mermaid\b/.test(entry.line));
	if (open < 0) return false;
	const body = section.slice(open + 1);
	const close = body.findIndex((entry) => entry.kind === "close");
	return close >= 0 && body.slice(0, close).some((entry) => entry.line.trim() !== "");
}

function lintAdr(record: AdrRecord, text: string, context: Context): Finding[] {
	const file = normalizePath(record.adrPath, context.root);
	const found: Finding[] = [];
	const add = (rule: string, message: string, extra: Partial<Finding> = {}): void => void found.push({ file, rule, message, ...extra });
	const present = new Set(outsideFences(text).map((line) => line.match(/^## (.*)$/)?.[1]?.trim()));
	for (const section of HUMAN_SECTIONS) if (!present.has(section)) add("missing-section", `missing section "## ${section}"`);
	if (present.has("Diagram") && !diagramHasMermaid(text)) add("missing-mermaid", "the Diagram section has no non-empty mermaid block");
	if (record.status === "") add("missing-status", "missing Status line");
	if (record.date === "") add("missing-date", "missing Date line");
	if (record.topic === "") add("missing-topic", "missing Topic line");
	if (record.level !== "" && !isLevel(record.level)) add("bad-level", `Level ${echo(record.level)} is not one of ${LEVELS.join(", ")}`);
	else {
		const level = isLevel(record.level) ? record.level : context.level;
		const limit = gradeLimit(level);
		const grade = round1(gradeOf(text));
		if (limit !== null && grade > limit) add("grade-too-high", `grade ${grade} exceeds ${level} limit ${limit}`, { grade, limit });
	}
	if ((context.adrCount.get(record.number) ?? 0) > 1) add("duplicate-number", `number ${record.number} is used by more than one ADR`);
	found.push(...brokenLinks(record.adrPath, text, context.root));
	return found;
}

function lintDecision(record: AdrRecord, text: string, context: Context): Finding[] {
	const file = normalizePath(record.decisionPath, context.root);
	const found: Finding[] = [];
	const add = (rule: string, message: string): void => void found.push({ file, rule, message });
	if (!("covers" in frontOf(text))) add("missing-covers", "front matter has no covers key");
	const pair = resolve(record.adrPath);
	if (!linkTargets(text).some((target) => targetPath(target, record.decisionPath, context.root) === pair)) add("broken-link", `does not link its ADR ${ADR_DIR}/${record.key}.md`);
	if ((context.decisionCount.get(record.number) ?? 0) > 1) add("duplicate-number", `number ${record.number} is used by more than one decision`);
	found.push(...brokenLinks(record.decisionPath, text, context.root));
	return found;
}

function lintRecord(record: AdrRecord, context: Context): Finding[] {
	const found: Finding[] = [];
	if (record.adrText === null) found.push({ file: normalizePath(record.decisionPath, context.root), rule: "orphan-decision", message: `no ADR ${ADR_DIR}/${record.key}.md for this decision` });
	else found.push(...lintAdr(record, record.adrText, context));
	if (record.decisionText === null) found.push({ file: normalizePath(record.adrPath, context.root), rule: "missing-pair", message: `no decision ${DECISION_DIR}/${record.key}.md for this ADR` });
	else found.push(...lintDecision(record, record.decisionText, context));
	return found;
}

function lintRepo(root: string, records: AdrRecord[]): Finding[] {
	const found: Finding[] = [];
	const readme = join(root, README_FILE);
	const { level } = frontOf(readFileSync(readme, "utf8"));
	if (typeof level !== "string" || !isLevel(level)) found.push({ file: README_FILE, rule: "bad-level", message: `README level ${typeof level === "string" ? echo(level) : "is missing"}; use one of ${LEVELS.join(", ")}` });
	const expected = renderIndexes(records);
	for (const [file, body] of [[TOC_FILE, expected.toc], [README_FILE, expected.readme]] as const) {
		const path = join(root, file);
		const text = existsSync(path) ? readFileSync(path, "utf8") : "";
		const at = text.indexOf(TOC_MARKER);
		if (at < 0 || text.slice(at + TOC_MARKER.length) !== indexTail(body)) found.push({ file, rule: "stale-index", message: "index is out of date. Run dg-skills adr index" });
		if (text !== "") found.push(...brokenLinks(path, text, root));
	}
	return found;
}

function countBy(records: AdrRecord[], has: (record: AdrRecord) => boolean): Map<string, number> {
	const counts = new Map<string, number>();
	for (const record of records.filter(has)) counts.set(record.number, (counts.get(record.number) ?? 0) + 1);
	return counts;
}

async function mergeBaseIn(root: string, ref: string): Promise<string> {
	return (await git`-C ${root} merge-base HEAD ${ref}`).text().trim();
}

async function changedPaths(root: string, base: string | undefined): Promise<string[]> {
	const branch = base === undefined ? await remoteDefaultBranch() : "";
	const refs = base === undefined ? [`origin/${branch}`, branch] : [base];
	let from = "";
	for (const ref of refs) {
		from = await mergeBaseIn(root, ref).catch(() => "");
		if (from !== "") break;
	}
	if (from === "") die(`no merge base between HEAD and ${refs.map(echo).join(" or ")}. Pass --base <ref>.`);
	const tracked = (await git`-C ${root} diff --name-only -z --no-renames ${from}`).text();
	const untracked = (await git`-C ${root} ls-files --others --exclude-standard -z`).text();
	return `${tracked}\0${untracked}`.split("\0").filter((line) => line !== "");
}

function report(found: Finding[], json: boolean): number {
	if (json) say(`${JSON.stringify(found)}\n`);
	else for (const finding of found) say(`${finding.file}: ${finding.rule}: ${finding.message}\n`);
	return found.length === 0 ? 0 : 1;
}

async function readStdin(): Promise<string> {
	const chunks: Uint8Array[] = [];
	let size = 0;
	for await (const chunk of Bun.stdin.stream()) {
		size += chunk.byteLength;
		if (size > MAX_GRADE_BYTES) die(`input is larger than ${MAX_GRADE_BYTES} bytes`);
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
}

async function gradeCommand(options: Options): Promise<number> {
	const source = options.grade as string;
	if (source !== "-") {
		const stat = statSync(source, { throwIfNoEntry: false });
		if (stat === undefined || !stat.isFile()) die(`cannot read ${echo(source)}: not a file`);
		if (stat.size > MAX_GRADE_BYTES) die(`${echo(source)} is larger than ${MAX_GRADE_BYTES} bytes`);
	}
	const text = source === "-" ? await readStdin() : readFileSync(source, "utf8");
	const level: Level = options.level === undefined ? repoLevel(repoRoot()) : parseLevel(options.level);
	const limit = gradeLimit(level);
	const grade = round1(gradeOf(text));
	const ok = limit === null || grade <= limit;
	if (options.json) say(`${JSON.stringify({ grade, limit, level, ok })}\n`);
	else say(`grade ${grade} ${ok ? "within" : "exceeds"} ${level} limit ${limit ?? "none"}\n`);
	return ok ? 0 : 1;
}

export async function lintCommand(args: string[]): Promise<number> {
	const options = parseOptions(args);
	if (options.modes.length === 1 && options.modes[0] === "--grade") return gradeCommand(options);
	const root = repoRoot();
	requireInitialized(root);
	if (options.modes.length !== 1) die(USAGE);
	const records = loadRecords(root);
	const context: Context = {
		root,
		level: repoLevel(root),
		adrCount: countBy(records, (record) => record.adrText !== null),
		decisionCount: countBy(records, (record) => record.decisionText !== null),
	};
	let scope = records;
	if (options.modes[0] === "--changed") {
		const paths = await changedPaths(root, options.base);
		const touched = new Set(paths.map((path) => normalizePath(path, root)));
		const covered = new Set(matchCovers(records, paths, root));
		scope = records.filter((record) => covered.has(record) || touched.has(normalizePath(record.adrPath, root)) || touched.has(normalizePath(record.decisionPath, root)));
	}
	return report([...scope.flatMap((record) => lintRecord(record, context)), ...lintRepo(root, records)], options.json);
}
