import * as fs from "node:fs";
import * as path from "node:path";

import type { ArchitectureGraph, MermaidPayload } from "./graph";

export interface PersistArchitectureResult {
	outPath: string;
	evidenceOutPath: string;
}

export function persistArchitecture(
	graph: ArchitectureGraph | MermaidPayload,
	markdown: string,
	outBasePath: string,
): PersistArchitectureResult {
	const outPath = `${outBasePath}.md`;
	const evidenceOutPath = `${outBasePath}.json`;

	fs.mkdirSync(path.dirname(outBasePath), { recursive: true });
	fs.writeFileSync(outPath, markdown, "utf-8");
	fs.writeFileSync(evidenceOutPath, JSON.stringify(graph, null, 2), "utf-8");

	return { outPath, evidenceOutPath };
}

export function persistHtml(html: string, outBasePath: string): string {
	const htmlOutPath = `${outBasePath}.html`;
	fs.mkdirSync(path.dirname(outBasePath), { recursive: true });
	fs.writeFileSync(htmlOutPath, html, "utf-8");
	return htmlOutPath;
}

export interface CheckGitignoredOptions {
	gitDir?: string;
	workTree?: string;
	runGit?: (args: string[]) => { status: number | null };
}

function defaultRunGit(args: string[]): { status: number | null } {
	const result = Bun.spawnSync(["git", ...args]);
	return { status: result.exitCode };
}

/** Warn-only: never throws, and any non-zero exit or spawn failure reads as "not ignored". */
export function checkGitignored(outPath: string, opts: CheckGitignoredOptions = {}): boolean {
	const args: string[] = [];
	if (opts.gitDir) args.push("--git-dir", opts.gitDir);
	if (opts.workTree) args.push("--work-tree", opts.workTree);
	args.push("check-ignore", outPath);

	const runGit = opts.runGit ?? defaultRunGit;

	try {
		return runGit(args).status === 0;
	} catch {
		return false;
	}
}
