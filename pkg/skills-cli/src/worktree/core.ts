import type { Dirent } from "node:fs";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	statSync,
	utimesSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
	branchExists,
	git,
	infoLine,
	listWorktrees,
	originBase,
	warnLine,
} from "./shared";

/** Create options shared by the worktree command and deps-upgrade. */
export interface CreateWorktreeOptions {
	slug: string;
	prefix?: string;
	base?: string;
	seed?: boolean;
	resume?: boolean;
	cwd?: string;
}

/** Primary repository plus the created or resumed checkout and branch. */
export interface WorktreeResult {
	path: string;
	branch: string;
	origin: string;
}

/** Lowercase and collapse every non-alphanumeric run to one underscore, trimmed at both ends. */
export function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_|_$/g, "");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function gitOrThrow(
	cwd: string,
	args: string[],
	reportDiagnostic?: (text: string) => void,
): Promise<string> {
	const result = await git(cwd, args);
	if (result.stdout) reportDiagnostic?.(result.stdout);
	if (result.stderr) reportDiagnostic?.(result.stderr);
	if (!result.ok)
		throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
	return result.stdout;
}

function seedConfig(
	source: string,
	destination: string,
	warn: (message: string) => void,
): void {
	const rootConfig =
		/^(?:\.env(?:\..*)?|\.envrc|\.tool-versions|\.nvmrc|\.(?:python|node|ruby|terraform)-version)$/;
	function visit(relative: string, depth: number): void {
		let entries: Dirent[];
		try {
			entries = readdirSync(path.join(source, relative), {
				withFileTypes: true,
			});
		} catch (error) {
			warn(
				`could not read ${relative || "."} for seeding: ${errorMessage(error)}`,
			);
			return;
		}
		for (const entry of entries) {
			if (entry.name === "node_modules" || entry.name === ".git") continue;
			const file = path.join(relative, entry.name);
			try {
				const from = path.join(source, file);
				const metadata = statSync(from);
				if (metadata.isDirectory()) {
					if (depth < 2 && !entry.name.startsWith(".")) visit(file, depth + 1);
					continue;
				}
				if (
					!metadata.isFile() ||
					!(depth === 0 ? rootConfig : /^\.env(?:\..*)?$/).test(entry.name)
				)
					continue;
				const to = path.join(destination, file);
				mkdirSync(path.dirname(to), { recursive: true });
				copyFileSync(from, to);
				chmodSync(to, metadata.mode & 0o7777);
				utimesSync(to, metadata.atime, metadata.mtime);
			} catch (error) {
				warn(`could not seed ${file}: ${errorMessage(error)}`);
			}
		}
	}
	visit("", 0);
}

/** Return data without stdout; formatted diagnostics default to stderr and failures reject. */
export async function createWorktree(
	options: CreateWorktreeOptions,
	reportDiagnostic: (text: string) => void = (text) => {
		process.stderr.write(text);
	},
): Promise<WorktreeResult> {
	const warn = (message: string): void => reportDiagnostic(warnLine(message));
	const info = (message: string): void => reportDiagnostic(infoLine(message));
	const slug = slugify(options.slug);
	if (!slug) throw new Error("slug normalized to empty string");
	const cwd = path.resolve(options.cwd ?? process.cwd());
	const worktrees = await listWorktrees(cwd).catch(() => {
		throw new Error("not in a git repo (run from within the repo)");
	});
	const origin = (worktrees[0] as { path: string }).path;
	const prefix = options.prefix ?? "feature/";
	const branch = `${prefix.endsWith("/") ? prefix : `${prefix}/`}${slug}`;
	const homeCode = path.join(process.env.HOME ?? homedir(), "code");
	const parent = origin.startsWith(`${homeCode}${path.sep}`)
		? path.join(homeCode, "worktrees")
		: path.dirname(origin);
	let target = path.join(parent, `${path.basename(origin)}-${slug}`);
	let base = options.base;
	if (!base) {
		base = await originBase(origin);
		if (!base)
			throw new Error(
				`could not resolve origin/HEAD; run: git -C ${origin} remote set-head origin -a`,
			);
	}
	if ((await gitOrThrow(origin, ["status", "--porcelain"])).trim())
		warn(
			"main repo has uncommitted changes — NOT carried into worktree. Stash if needed.",
		);
	if (
		(
			await gitOrThrow(origin, ["status", "--porcelain", "--", ".agents/"])
		).trim()
	)
		warn(
			"uncommitted .agents/ changes won't be visible in the worktree until merged.",
		);
	const hasBranch = await branchExists(origin, branch);
	const hasPath = existsSync(target);
	if (options.resume === false && (hasBranch || hasPath))
		throw new Error(
			`state exists (branch=${Number(hasBranch)} path=${Number(hasPath)}) and --no-resume was passed`,
		);
	if (hasBranch && hasPath) {
		const existing = worktrees.find((entry) => entry.branch === branch)?.path;
		if (!existing)
			throw new Error(
				`path ${target} exists but branch ${branch} is not checked out there — investigate manually`,
			);
		if (existing !== target) {
			warn(`branch checked out at ${existing}, not ${target} — using existing`);
			target = existing;
		}
		info(`resuming existing worktree: ${target}`);
	} else if (hasBranch) {
		info(
			`branch ${branch} exists but worktree missing — recreating at ${target}`,
		);
		try {
			await gitOrThrow(
				origin,
				["worktree", "add", target, branch],
				reportDiagnostic,
			);
		} catch {
			throw new Error(`failed to add worktree at ${target}`);
		}
		if (options.seed !== false) seedConfig(origin, target, warn);
	} else if (hasPath) {
		throw new Error(
			`path ${target} exists but no matching branch — investigate manually`,
		);
	} else {
		info(`fetching origin/${base}...`);
		try {
			await gitOrThrow(origin, ["fetch", "origin", base], reportDiagnostic);
		} catch {
			warn(`fetch origin/${base} failed — proceeding with local ref`);
		}
		info(`creating worktree: ${target} (branch ${branch} from origin/${base})`);
		mkdirSync(parent, { recursive: true });
		try {
			await gitOrThrow(
				origin,
				["worktree", "add", target, "-b", branch, `origin/${base}`],
				reportDiagnostic,
			);
		} catch {
			throw new Error("failed to create worktree");
		}
		if (options.seed !== false) seedConfig(origin, target, warn);
	}
	return { path: target, branch, origin };
}
