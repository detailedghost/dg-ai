import {
	existsSync,
	mkdirSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import {
	agentsPath,
	agentsRoot,
	cwdHash,
	NotInWorktreeError,
	projectHash,
	projectRoot,
	randSuffix,
	readableSuffix,
	repoRoot,
	scratchDir,
	scratchRoot,
	stateDir,
	stateRoot,
} from "@dg/common/node";
import { INDEX_FILE, type JotLayout } from "./layout";

export type JotKind = "note" | "save";

export interface JotEntry {
	kind: JotKind;
	name: string;
	file: string;
	mtimeMs: number;
}

function noteReadDir(): string {
	return path.join(scratchRoot(), "jot", cwdHash());
}

function stateReadDir(): string {
	return path.join(stateRoot(), "jot", projectHash());
}

function repoSaveDir(): string | null {
	try {
		const root = agentsRoot({ main: true });
		return existsSync(root) ? path.join(root, "jot") : null;
	} catch (error) {
		if (error instanceof NotInWorktreeError) return null;
		throw error;
	}
}

/** True when cwd is a linked worktree, which saves to state. */
function inLinkedWorktree(): boolean {
	const top = repoRoot();
	return top !== null && path.resolve(top) !== path.resolve(projectRoot());
}

export function noteWriteDir(): string {
	return scratchDir("jot");
}

export function saveWriteDir(): string {
	const repo = repoSaveDir();
	if (repo && !inLinkedWorktree())
		return agentsPath("jot", undefined, { main: true });
	return stateDir("jot");
}

export function ensureRepoIgnore(dir: string): void {
	if (dir !== repoSaveDir()) return;
	const gitignore = path.join(dir, ".gitignore");
	if (!existsSync(gitignore)) writeFileSync(gitignore, "*\n");
}

function readDirs(): { kind: JotKind; dir: string }[] {
	const repo = repoSaveDir();
	const saves = repo ? [repo, stateReadDir()] : [stateReadDir()];
	return [
		{ kind: "note", dir: noteReadDir() },
		...saves.map((dir) => ({ kind: "save" as const, dir })),
	];
}

function nameTaken(name: string): boolean {
	return readDirs().some(
		({ dir }) =>
			existsSync(path.join(dir, `${name}.md`)) ||
			existsSync(path.join(dir, name)),
	);
}

export function jotName(): string {
	for (let attempt = 0; attempt < 20; attempt++) {
		const name = `jot-${readableSuffix()}`;
		if (!nameTaken(name)) return name;
	}
	return `jot-${readableSuffix()}-${randSuffix(6)}`;
}

/** Writes a laid-out jot into `dir` and returns the path of the file or folder. */
export function writeJot(dir: string, name: string, layout: JotLayout): string {
	mkdirSync(dir, { recursive: true });
	if ("single" in layout) {
		const file = path.join(dir, `${name}.md`);
		writeFileSync(file, layout.single);
		return file;
	}
	const folder = path.join(dir, name);
	mkdirSync(folder, { recursive: true });
	for (const part of layout.parts)
		writeFileSync(path.join(folder, part.file), part.body);
	writeFileSync(path.join(folder, INDEX_FILE), layout.index);
	return folder;
}

export function listEntries(): JotEntry[] {
	const entries: JotEntry[] = [];
	for (const { kind, dir } of readDirs()) {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			continue;
		}
		for (const f of names) {
			if (!f.startsWith("jot-")) continue;
			const full = path.join(dir, f);
			const stat = statSync(full);
			if (stat.isDirectory()) {
				const index = path.join(full, INDEX_FILE);
				if (existsSync(index))
					entries.push({ kind, name: f, file: index, mtimeMs: stat.mtimeMs });
			} else if (f.endsWith(".md")) {
				entries.push({
					kind,
					name: f.slice(0, -3),
					file: full,
					mtimeMs: stat.mtimeMs,
				});
			}
		}
	}
	return entries.sort(
		(a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name),
	);
}

export function resolveJot(ref: string): {
	kind: JotKind;
	target: string;
	isFolder: boolean;
} {
	const name = path.basename(ref).replace(/\.md$/, "");
	for (const { kind, dir } of readDirs()) {
		if (
			path.isAbsolute(ref) &&
			path.resolve(path.dirname(ref)) !== path.resolve(dir)
		)
			continue;
		const file = path.join(dir, `${name}.md`);
		if (existsSync(file)) return { kind, target: file, isFolder: false };
		const folder = path.join(dir, name);
		if (existsSync(path.join(folder, INDEX_FILE)))
			return { kind, target: folder, isFolder: true };
	}
	throw new Error(`no jot named ${ref}; run dg-skills jot ls`);
}
