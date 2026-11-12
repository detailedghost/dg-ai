import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { escapeRegExp } from "@dg/common";
import { isPathInside } from "@dg/common/node";
import { invertEdges } from "../erd/graph";
import { collectImportGraph } from "../erd/import-graph";
import { categoryOf, type DiffFile, type DiffLine } from "./core";

export const MAX_SYMBOLS_PER_FILE = 50;
export const MAX_HITS_DEFAULT = 20;
export const INVESTIGATE_BUDGET_MS = 60_000;

export interface CallerHit {
	path: string;
	line: number;
	symbol: string;
}

export interface InvestigatedFile {
	path: string;
	symbols: string[];
	dependents: string[];
	callers: CallerHit[];
	tests: string[];
	truncated: boolean;
}

export interface Investigation {
	root: string;
	files: InvestigatedFile[];
}

export interface InvestigateOptions {
	maxHits: number;
	budgetMs: number;
	diffFiles?: Map<string, DiffFile>;
	now?: () => number;
}

export class InvestigateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvestigateError";
	}
}

const IDENT = String.raw`([A-Za-z_$][\w$]*)`;
const NOT_METHODS = new Set(["if", "for", "while", "switch", "catch", "function", "return", "with", "constructor", "super"]);

const JS_DECLARATIONS: RegExp[] = [
	new RegExp(String.raw`^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*${IDENT}`),
	new RegExp(String.raw`^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+${IDENT}`),
	new RegExp(String.raw`^(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+${IDENT}`),
	new RegExp(String.raw`^\s*(?:export\s+)?(?:declare\s+)?interface\s+${IDENT}`),
	new RegExp(String.raw`^\s*(?:export\s+)?(?:declare\s+)?type\s+${IDENT}\s*[=<]`),
	new RegExp(String.raw`^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+${IDENT}`),
	new RegExp(
		String.raw`^\s+(?:(?:public|private|protected|static|readonly|async|override|abstract|get|set)\s+)*\*?\s*${IDENT}\s*(?:<[^>\n]*>)?\([^)\n]*\)\s*(?::\s*[^={;\n]+)?\s*\{`,
	),
	new RegExp(String.raw`^\s*export\s+default\s+${IDENT}\s*;?\s*$`),
];

const PY_DECLARATIONS: RegExp[] = [
	new RegExp(String.raw`^\s*(?:async\s+)?def\s+${IDENT}`),
	new RegExp(String.raw`^\s*class\s+${IDENT}`),
];

const JS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);

function declarationsFor(filePath: string): RegExp[] {
	const ext = path.extname(filePath);
	if (JS_EXTENSIONS.has(ext)) return JS_DECLARATIONS;
	if (ext === ".py") return PY_DECLARATIONS;
	return [];
}

function symbolsFromText(filePath: string, texts: Iterable<string>): string[] {
	const table = declarationsFor(filePath);
	const found = new Set<string>();
	if (table.length === 0) return [];
	for (const text of texts) {
		for (const re of table) {
			const name = re.exec(text)?.[1];
			if (name === undefined) continue;
			if (/\w/.test(name) && !NOT_METHODS.has(name)) found.add(name);
			break;
		}
		if (found.size >= MAX_SYMBOLS_PER_FILE) break;
	}
	return [...found].slice(0, MAX_SYMBOLS_PER_FILE);
}

export function symbolsFromDiffLines(filePath: string, lines: DiffLine[]): string[] {
	return symbolsFromText(
		filePath,
		lines.filter((line) => line.kind !== "context").map((line) => line.text),
	);
}

function git(root: string, args: string[], timeout?: number) {
	try {
		return Bun.spawnSync(["git", "-C", root, ...args], {
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
			stdout: "pipe",
			stderr: "pipe",
			timeout,
			killSignal: "SIGKILL",
		});
	} catch (error) {
		throw new InvestigateError(`git ${args[0]} could not start: ${(error as Error).message}`);
	}
}

export function listTrackedFiles(root: string, pathspec?: string): string[] {
	const result = git(root, ["ls-files", "-z", ...(pathspec === undefined ? [] : ["--", pathspec])]);
	if (result.exitCode !== 0) {
		throw new InvestigateError(`git ls-files failed with exit code ${result.exitCode}: ${result.stderr.toString().trim()}`);
	}
	return result.stdout
		.toString()
		.split("\0")
		.filter((file) => file !== "" && isPathInside(path.resolve(root, file), root));
}

function pairedTests(filePath: string, tracked: string[]): string[] {
	const name = path.basename(filePath, path.extname(filePath));
	const parent = path.basename(path.dirname(filePath));
	const names = [escapeRegExp(name)];
	if (parent !== "." && parent !== "") names.push(escapeRegExp(`${parent}-${name}`));
	const pair = new RegExp(
		`^(?:(?:${names.join("|")})\\.(?:spec|test)\\..+|test_${escapeRegExp(name)}\\..+|${escapeRegExp(name)}_test\\..+)$`,
	);
	return tracked.filter((candidate) => candidate !== filePath && pair.test(path.basename(candidate)));
}

type GrepOutcome = { kind: "hits"; hits: CallerHit[] } | { kind: "timeout" };

function grepCallers(
	root: string,
	symbol: string,
	ownPath: string,
	timeout: number | undefined,
	limit: number,
): GrepOutcome {
	const result = git(root, ["-c", "core.quotepath=false", "grep", "-n", "-w", "-F", "-I", "--no-textconv", "-e", symbol, "--", "."], timeout);
	if (result.exitedDueToTimeout) return { kind: "timeout" };
	if (result.exitCode === 1) return { kind: "hits", hits: [] };
	if (result.exitCode !== 0) {
		throw new InvestigateError(
			`git grep failed with exit code ${result.exitCode}: ${result.stderr.toString().trim()}`,
		);
	}
	const hits: CallerHit[] = [];
	for (const row of result.stdout.toString().split("\n")) {
		const match = /^(.+?):(\d+):/.exec(row);
		if (!match) continue;
		const hitPath = match[1];
		if (hitPath === ownPath || !isPathInside(path.resolve(root, hitPath), root)) continue;
		hits.push({ path: hitPath, line: Number(match[2]), symbol });
		if (hits.length > limit) break;
	}
	return { kind: "hits", hits };
}

function readWholeFile(root: string, filePath: string): string | null {
	const abs = path.resolve(root, filePath);
	if (!isPathInside(abs, root)) throw new InvestigateError(`path is outside the root: ${filePath}`);
	let real: string;
	try {
		real = realpathSync(abs);
	} catch {
		return null;
	}
	if (!isPathInside(real, realpathSync(root))) throw new InvestigateError(`path is outside the root: ${filePath}`);
	try {
		const buffer = readFileSync(real);
		return buffer.subarray(0, 8000).includes(0) ? null : buffer.toString("utf8");
	} catch {
		return null;
	}
}

function emptyFile(filePath: string, truncated: boolean): InvestigatedFile {
	return { path: filePath, symbols: [], dependents: [], callers: [], tests: [], truncated };
}

function symbolsOf(root: string, filePath: string, diffFile: DiffFile | undefined): string[] | null {
	if (diffFile) {
		if (diffFile.status === "deleted" || diffFile.status === "binary") return null;
		return symbolsFromDiffLines(filePath, diffFile.lines);
	}
	const content = readWholeFile(root, filePath);
	return content === null ? null : symbolsFromText(filePath, content.split("\n"));
}

export function investigate(root: string, paths: string[], options: InvestigateOptions): Investigation {
	const now = options.now ?? Date.now;
	const deadline = now() + options.budgetMs;
	const bounded = Number.isFinite(deadline);
	const cut = (filePath: string) => emptyFile(filePath, true);

	for (const filePath of paths) {
		if (!isPathInside(path.resolve(root, filePath), root)) {
			throw new InvestigateError(`path is outside the root: ${filePath}`);
		}
	}

	if (bounded && now() >= deadline) return { root, files: paths.map(cut) };

	const dependentsOf = invertEdges(collectImportGraph({ scopePath: root }).edges);
	const tracked = listTrackedFiles(root);
	const files: InvestigatedFile[] = [];

	for (const filePath of paths) {
		if (bounded && now() >= deadline) {
			files.push(cut(filePath));
			continue;
		}
		const symbols = symbolsOf(root, filePath, options.diffFiles?.get(filePath));
		if (symbols === null) {
			files.push(emptyFile(filePath, false));
			continue;
		}

		const callers: CallerHit[] = [];
		let truncated = false;
		let timedOut = false;
		for (const symbol of symbols) {
			const timeout = bounded ? Math.max(1, deadline - now()) : undefined;
			const outcome = grepCallers(root, symbol, filePath, timeout, options.maxHits);
			if (outcome.kind === "timeout") {
				timedOut = true;
				break;
			}
			for (const hit of outcome.hits) {
				if (callers.length < options.maxHits) callers.push(hit);
				else truncated = true;
			}
			if (truncated) break;
		}
		if (timedOut) {
			files.push({ ...cut(filePath), symbols });
			continue;
		}

		const dependents = (dependentsOf.get(filePath) ?? []).filter((dependent) => dependent !== filePath);
		const tests = [
			...new Set([...pairedTests(filePath, tracked), ...dependents.filter((dependent) => categoryOf(dependent) === "test")]),
		].sort();
		files.push({ path: filePath, symbols, dependents, callers, tests, truncated });
	}

	return { root, files };
}
