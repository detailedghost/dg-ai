import * as fs from "node:fs";
import * as path from "node:path";

import { DEFAULT_IGNORE_DIRS, DEFAULT_SECRET_FILE_PATTERNS, isSecretFile, toPosix } from "./code-graph";
import type { CodeEdge, EvidenceRecord } from "./graph";

export interface CollectImportGraphOptions {
	scopePath: string;
	depth?: number;
	ignoreDirs?: string[];
	secretFilePatterns?: RegExp[];
	maxFileSizeBytes?: number;
}

export interface CollectImportGraphResult {
	edges: CodeEdge[];
	evidence: EvidenceRecord[];
	truncated: { edges: number };
}

const DEFAULT_MAX_FILE_SIZE_BYTES = 1_000_000;

const ALLOWED_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py"];
const JS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

const JS_IMPORT_FROM_RE = /^\s{0,20}import\s[\s\S]{1,300}?from\s+['"]([^'"\n]{1,500})['"]/gm;
const JS_EXPORT_FROM_RE = /^\s{0,20}export\s[\s\S]{1,300}?from\s+['"]([^'"\n]{1,500})['"]/gm;
const JS_BARE_IMPORT_RE = /^\s{0,20}import\s+['"]([^'"\n]{1,500})['"]/gm;
const JS_REQUIRE_RE = /^\s{0,20}(?:const|let|var)\s[\s\S]{1,200}?=\s{0,10}require\(\s*['"]([^'"\n]{1,500})['"]\s*\)/gm;
const PY_FROM_IMPORT_RE = /^\s{0,20}from\s+([.\w]{1,300})\s+import\b/gm;
const PY_IMPORT_RE = /^\s{0,20}import\s+([.\w]{1,300})/gm;

function hasNullByte(absPath: string): boolean {
	const fd = fs.openSync(absPath, "r");
	try {
		const buf = Buffer.alloc(8192);
		const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
		return buf.subarray(0, bytesRead).includes(0);
	} finally {
		fs.closeSync(fd);
	}
}

function lineNumberAt(matchIndex: number, content: string): number {
	return content.slice(0, matchIndex).split("\n").length;
}

function tryResolveJs(basePathNoExt: string): string | undefined {
	if (fs.existsSync(basePathNoExt) && fs.statSync(basePathNoExt).isFile()) return basePathNoExt;
	for (const ext of JS_EXTENSIONS) {
		const candidate = basePathNoExt + ext;
		if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
	}
	for (const ext of JS_EXTENSIONS) {
		const candidate = path.join(basePathNoExt, `index${ext}`);
		if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
	}
	return undefined;
}

function tryResolvePython(basePathNoExt: string): string | undefined {
	const asPy = `${basePathNoExt}.py`;
	if (fs.existsSync(asPy) && fs.statSync(asPy).isFile()) return asPy;
	const asInit = path.join(basePathNoExt, "__init__.py");
	if (fs.existsSync(asInit) && fs.statSync(asInit).isFile()) return asInit;
	if (fs.existsSync(basePathNoExt) && fs.statSync(basePathNoExt).isFile()) return basePathNoExt;
	return undefined;
}

function resolveJsSpecifier(fromAbsPath: string, specifier: string): string | undefined {
	if (!specifier.startsWith("./") && !specifier.startsWith("../")) return undefined;
	const basePathNoExt = path.resolve(path.dirname(fromAbsPath), specifier);
	return tryResolveJs(basePathNoExt);
}

function resolvePythonSpecifier(fromAbsPath: string, specifier: string): string | undefined {
	const dotMatch = specifier.match(/^\.+/);
	if (!dotMatch) return undefined;

	const leadingDots = dotMatch[0].length;
	const remainder = specifier.slice(leadingDots);
	const upDirs = leadingDots - 1;

	let targetDir = path.dirname(fromAbsPath);
	for (let i = 0; i < upDirs; i++) {
		targetDir = path.dirname(targetDir);
	}

	const remainderPath = remainder.length > 0 ? remainder.split(".").join(path.sep) : "";
	const basePathNoExt = remainderPath ? path.join(targetDir, remainderPath) : targetDir;
	return tryResolvePython(basePathNoExt);
}

export function collectImportGraph(opts: CollectImportGraphOptions): CollectImportGraphResult {
	const {
		scopePath,
		depth,
		ignoreDirs = DEFAULT_IGNORE_DIRS,
		secretFilePatterns = DEFAULT_SECRET_FILE_PATTERNS,
		maxFileSizeBytes = DEFAULT_MAX_FILE_SIZE_BYTES,
	} = opts;

	if (!fs.existsSync(scopePath)) {
		throw new Error(`erd-import-graph: scopePath does not exist: ${scopePath}`);
	}

	const edges: CodeEdge[] = [];
	const evidence: EvidenceRecord[] = [];
	let truncatedEdges = 0;

	const files: { relPath: string; absPath: string }[] = [];

	function walk(absDir: string, relDir: string, currentDepth: number): void {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(absDir, { withFileTypes: true });
		} catch (err) {
			evidence.push({
				type: "file",
				ref: relDir,
				detail: `skipped: could not read directory (${(err as Error).message})`,
			});
			return;
		}

		for (const entry of entries) {
			const entryRelPath = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
			const entryAbsPath = path.join(absDir, entry.name);

			if (entry.isDirectory()) {
				if (ignoreDirs.includes(entry.name)) continue;

				if (depth !== undefined && currentDepth >= depth) {
					truncatedEdges += 1;
					continue;
				}

				walk(entryAbsPath, entryRelPath, currentDepth + 1);
			} else if (entry.isFile()) {
				if (isSecretFile(entryRelPath, entry.name, secretFilePatterns)) continue;
				files.push({ relPath: entryRelPath, absPath: entryAbsPath });
			}
		}
	}

	walk(scopePath, "", 0);

	const walkedRelPaths = new Set(files.map((file) => file.relPath));

	for (const { relPath, absPath } of files) {
		const ext = path.extname(relPath);
		if (!ALLOWED_EXTENSIONS.includes(ext)) continue;

		let content: string;
		try {
			const stat = fs.statSync(absPath);
			if (stat.size > maxFileSizeBytes) {
				evidence.push({ type: "file", ref: relPath, detail: "skipped: exceeds size cap" });
				continue;
			}

			if (hasNullByte(absPath)) {
				evidence.push({ type: "file", ref: relPath, detail: "skipped: binary file" });
				continue;
			}

			content = fs.readFileSync(absPath, "utf8");
		} catch (err) {
			evidence.push({
				type: "file",
				ref: relPath,
				detail: `skipped: could not read file (${(err as Error).message})`,
			});
			continue;
		}
		const lines = content.split("\n");
		const isPython = ext === ".py";
		const regexes = isPython
			? [PY_FROM_IMPORT_RE, PY_IMPORT_RE]
			: [JS_IMPORT_FROM_RE, JS_EXPORT_FROM_RE, JS_BARE_IMPORT_RE, JS_REQUIRE_RE];

		for (const re of regexes) {
			re.lastIndex = 0;
			let match: RegExpExecArray | null;
			while ((match = re.exec(content)) !== null) {
				const specifier = match[1];
				const resolvedAbsPath = isPython
					? resolvePythonSpecifier(absPath, specifier)
					: resolveJsSpecifier(absPath, specifier);
				if (!resolvedAbsPath) continue;

				const targetRelPath = toPosix(path.relative(scopePath, resolvedAbsPath));
				const targetSegments = targetRelPath.split("/");
				if (targetSegments.some((seg) => ignoreDirs.includes(seg))) continue;
				const targetBasename = targetSegments[targetSegments.length - 1] ?? "";
				if (isSecretFile(targetRelPath, targetBasename, secretFilePatterns)) continue;
				if (!walkedRelPaths.has(targetRelPath)) continue;

				const lineNumber = lineNumberAt(match.index, content);
				const lineText = lines[lineNumber - 1]?.trim() ?? "";
				const evidenceDetail = `line ${lineNumber}: ${lineText}`;

				edges.push({ from: relPath, to: targetRelPath, kind: "import", evidence: evidenceDetail });
				evidence.push({ type: "import", ref: relPath, detail: evidenceDetail });
			}
		}
	}

	return { edges, evidence, truncated: { edges: truncatedEdges } };
}
