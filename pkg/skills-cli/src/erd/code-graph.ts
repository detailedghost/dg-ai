import * as fs from "node:fs";
import * as path from "node:path";

import type { CodeNode, EvidenceRecord } from "./graph";

export const DEFAULT_IGNORE_DIRS: string[] = [
	"node_modules",
	".git",
	"dist",
	"build",
	"vendor",
	".venv",
	".next",
	"coverage",
	"target",
	"__pycache__",
	".cache",
	"out",
];

export const DEFAULT_SECRET_FILE_PATTERNS: RegExp[] = [
	/^\.env(\..+)?$/,
	/\.pem$/,
	/^id_rsa/,
	/^id_ecdsa/,
	/^id_ed25519/,
	/\.key$/,
	/\.crt$/,
	/\.pfx$/,
	/^\.npmrc$/,
	/^\.git-credentials$/,
	/\.tfvars$/,
	/(^|\/)\.aws\/credentials$/,
];

export interface CollectCodeGraphOptions {
	scopePath: string;
	depth?: number;
	ignoreDirs?: string[];
	secretFilePatterns?: RegExp[];
}

export interface CollectCodeGraphResult {
	nodes: CodeNode[];
	evidence: EvidenceRecord[];
	truncated: { nodes: number };
}

export function toPosix(relPath: string): string {
	return relPath.split(path.sep).join("/");
}

export function isSecretFile(relPath: string, basename: string, secretFilePatterns: RegExp[]): boolean {
	return secretFilePatterns.some((re) => re.test(basename) || re.test(toPosix(relPath)));
}

export function collectCodeGraph(opts: CollectCodeGraphOptions): CollectCodeGraphResult {
	const {
		scopePath,
		depth,
		ignoreDirs = DEFAULT_IGNORE_DIRS,
		secretFilePatterns = DEFAULT_SECRET_FILE_PATTERNS,
	} = opts;

	if (!fs.existsSync(scopePath)) {
		throw new Error(`erd-code-graph: scopePath does not exist: ${scopePath}`);
	}

	const nodes: CodeNode[] = [];
	const evidence: EvidenceRecord[] = [];
	let truncatedNodes = 0;

	function walk(absDir: string, relDir: string, currentDepth: number): { fileCount: number } {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(absDir, { withFileTypes: true });
		} catch (err) {
			evidence.push({
				type: "file",
				ref: relDir,
				detail: `skipped: could not read directory (${(err as Error).message})`,
			});
			return { fileCount: 0 };
		}
		let fileCount = 0;

		for (const entry of entries) {
			const entryRelPath = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
			const entryAbsPath = path.join(absDir, entry.name);

			if (entry.isDirectory()) {
				if (ignoreDirs.includes(entry.name)) continue;

				if (depth !== undefined && currentDepth >= depth) {
					truncatedNodes += 1;
					continue;
				}

				const sub = walk(entryAbsPath, entryRelPath, currentDepth + 1);
				nodes.push({ id: entryRelPath, label: entry.name, kind: "dir", fileCount: sub.fileCount });
				evidence.push({ type: "file", ref: entryRelPath });
				fileCount += 1;
			} else if (entry.isFile()) {
				if (isSecretFile(entryRelPath, entry.name, secretFilePatterns)) continue;

				let stat: fs.Stats;
				try {
					stat = fs.statSync(entryAbsPath);
				} catch (err) {
					evidence.push({
						type: "file",
						ref: entryRelPath,
						detail: `skipped: could not stat file (${(err as Error).message})`,
					});
					continue;
				}
				nodes.push({ id: entryRelPath, label: entry.name, kind: "file", sizeBytes: stat.size });
				evidence.push({ type: "file", ref: entryRelPath });
				fileCount += 1;
			}
		}

		return { fileCount };
	}

	walk(scopePath, "", 0);

	return { nodes, evidence, truncated: { nodes: truncatedNodes } };
}
