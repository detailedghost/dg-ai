import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { die, say } from "../spec/shared";
import { parseYaml, splitDocument } from "../utils/frontmatter";
import { git, mergeBase, remoteDefaultBranch } from "../utils/git";
import { indexTail, renderIndexes } from "./index-gen";
import { gradeLimit, isLevel, LEVELS, parseLevel, type Level } from "./levels";
import { README_FILE, repoRoot, requireInitialized, TOC_FILE } from "./paths";
import { outsideFences, gradeOf } from "./readability";
import { type AdrRecord, loadRecords, matchCovers, normalizePath, repoLevel } from "./records";
import { HUMAN_SECTIONS, TOC_MARKER } from "./templates";

const USAGE = "usage: dg-skills adr lint (--all | --changed [--base <ref>] | --grade <file|->) [--level <l>] [--json]";

interface Finding {
	file: string;
	rule: string;
	message: string;
	grade?: number;
	limit?: number | null;
}

interface Options {
	modes: string[];
	json: boolean;
	base?: string;
	grade?: string;
	level?: string;
}

interface Context {
	root: string;
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
			if (arg === "--grade") options.modes.push(arg);
			options[arg.slice(2) as "base" | "grade" | "level"] = value;
		} else die(USAGE);
	}
	return options;
}

function round1(value: number): number {
	return Math.round(value * 10) / 10;
}

function rel(path: string, root: string): string {
	return normalizePath(path, root);
}

function headingsOf(text: string): string[] {
	return outsideFences(text)
		.map((line) => line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/)?.[1])
		.filter((heading): heading is string => heading !== undefined);
}

function linkTargets(text: string): string[] {
	const prose = outsideFences(text).join("\n").replace(/`[^`]*`/g, " ");
	return [...prose.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((match) => match[1] ?? "");
}

function anchorOf(heading: string): string {
	return heading.toLowerCase().replace(/[^\p{L}\p{N}_\s-]/gu, "").trim().replaceAll(" ", "-");
}

function brokenLinks(path: string, text: string, root: string): Finding[] {
	const anchors = new Set(headingsOf(text).map(anchorOf));
	const file = rel(path, root);
	const found: Finding[] = [];
	for (const target of linkTargets(text)) {
		if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
		if (target.startsWith("#")) {
			if (!anchors.has(target.slice(1))) found.push({ file, rule: "broken-link", message: `anchor ${target} matches no heading` });
			continue;
		}
		const filePart = target.split(/[#?]/)[0] ?? "";
		if (filePart !== "" && !existsSync(resolve(dirname(path), filePart))) found.push({ file, rule: "broken-link", message: `link target ${target} does not exist` });
	}
	return found;
}

function diagramHasMermaid(text: string): boolean {
	const start = text.search(/^## Diagram[ \t]*$/m);
	const section = text.slice(start).split(/^## /m)[1] ?? "";
	return (section.match(/```mermaid[^\n]*\n([\s\S]*?)```/)?.[1] ?? "").trim() !== "";
}

function lintAdr(record: AdrRecord, text: string, context: Context): Finding[] {
	const file = rel(record.adrPath, context.root);
	const found: Finding[] = [];
	const add = (rule: string, message: string, extra: Partial<Finding> = {}): void => void found.push({ file, rule, message, ...extra });
	const present = new Set(outsideFences(text).map((line) => line.match(/^## (.+?)\s*$/)?.[1]));
	for (const section of HUMAN_SECTIONS) if (!present.has(section)) add("missing-section", `missing section "## ${section}"`);
	if (present.has("Diagram") && !diagramHasMermaid(text)) add("missing-mermaid", "the Diagram section has no non-empty mermaid block");
	if (record.status === "") add("missing-status", "missing Status line");
	if (record.date === "") add("missing-date", "missing Date line");
	if (record.topic === "") add("missing-topic", "missing Topic line");
	if (record.level !== "" && !isLevel(record.level)) add("bad-level", `Level "${record.level}" is not one of ${LEVELS.join(", ")}`);
	else {
		const level = isLevel(record.level) ? record.level : repoLevel(context.root);
		const limit = gradeLimit(level);
		const grade = round1(gradeOf(text));
		if (limit !== null && grade > limit) add("grade-too-high", `grade ${grade} exceeds ${level} limit ${limit}`, { grade, limit });
	}
	if ((context.adrCount.get(record.number) ?? 0) > 1) add("duplicate-number", `number ${record.number} is used by more than one ADR`);
	found.push(...brokenLinks(record.adrPath, text, context.root));
	return found;
}

function lintDecision(record: AdrRecord, text: string, context: Context): Finding[] {
	const file = rel(record.decisionPath, context.root);
	const found: Finding[] = [];
	const add = (rule: string, message: string): void => void found.push({ file, rule, message });
	const parsed = parseYaml(splitDocument(text).front);
	const front = parsed.ok && typeof parsed.value === "object" && parsed.value !== null ? parsed.value : {};
	if (!("covers" in front)) add("missing-covers", "front matter has no covers key");
	const pair = resolve(record.adrPath);
	if (!linkTargets(text).some((target) => resolve(dirname(record.decisionPath), target.split(/[#?]/)[0] ?? "") === pair)) add("broken-link", `does not link its ADR docs/adr/${record.key}.md`);
	if ((context.decisionCount.get(record.number) ?? 0) > 1) add("duplicate-number", `number ${record.number} is used by more than one decision`);
	found.push(...brokenLinks(record.decisionPath, text, context.root));
	return found;
}

function lintRecord(record: AdrRecord, context: Context): Finding[] {
	const found: Finding[] = [];
	if (record.adrText === null) found.push({ file: rel(record.decisionPath, context.root), rule: "orphan-decision", message: `no ADR docs/adr/${record.key}.md for this decision` });
	else found.push(...lintAdr(record, record.adrText, context));
	if (record.decisionText === null) found.push({ file: rel(record.adrPath, context.root), rule: "missing-pair", message: `no decision .agents/decisions/${record.key}.md for this ADR` });
	else found.push(...lintDecision(record, record.decisionText, context));
	return found;
}

function lintRepo(root: string, records: AdrRecord[]): Finding[] {
	const found: Finding[] = [];
	const readme = join(root, README_FILE);
	const parsed = parseYaml(splitDocument(readFileSync(readme, "utf8")).front);
	const level = parsed.ok && typeof parsed.value === "object" && parsed.value !== null ? (parsed.value as { level?: unknown }).level : undefined;
	if (typeof level !== "string" || !isLevel(level)) found.push({ file: README_FILE, rule: "bad-level", message: `README level ${typeof level === "string" ? `"${level}"` : "is missing"}; use one of ${LEVELS.join(", ")}` });
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

async function changedPaths(root: string, base: string | undefined): Promise<string[]> {
	let from: string;
	if (base !== undefined) from = await mergeBase(base);
	else {
		const branch = await remoteDefaultBranch();
		from = await mergeBase(`origin/${branch}`)
			.catch(() => mergeBase(branch))
			.catch(() => "HEAD");
	}
	const tracked = (await git`-C ${root} diff --name-only --no-renames ${from}`).text();
	const untracked = (await git`-C ${root} ls-files --others --exclude-standard`).text();
	return `${tracked}\n${untracked}`.split("\n").filter((line) => line !== "");
}

function report(found: Finding[], json: boolean): number {
	if (json) say(`${JSON.stringify(found)}\n`);
	else for (const finding of found) say(`${finding.file}: ${finding.rule}: ${finding.message}\n`);
	return found.length === 0 ? 0 : 1;
}

async function gradeCommand(options: Options): Promise<number> {
	const source = options.grade as string;
	const text = source === "-" ? await Bun.stdin.text() : readFileSync(source, "utf8");
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
	const records = await loadRecords(root);
	const context: Context = {
		root,
		adrCount: countBy(records, (record) => record.adrText !== null),
		decisionCount: countBy(records, (record) => record.decisionText !== null),
	};
	let scope = records;
	if (options.modes[0] === "--changed") {
		const paths = await changedPaths(root, options.base);
		const touched = new Set(paths.map((path) => normalizePath(path, root)));
		const covered = new Set(matchCovers(records, paths, root));
		scope = records.filter((record) => covered.has(record) || touched.has(rel(record.adrPath, root)) || touched.has(rel(record.decisionPath, root)));
	}
	return report([...scope.flatMap((record) => lintRecord(record, context)), ...lintRepo(root, records)], options.json);
}
