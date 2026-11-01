import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	type Stats,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
	scratchRoot,
	selfCommand,
	stateRoot,
	writeFileAtomic,
} from "@dg/common/node";
import type { CommandRunner, HookEnv, HookHandler } from "../types";

const DAY_MS = 86_400_000;
export const SCRATCH_TTL_MS = 14 * DAY_MS;
export const STATE_TTL_MS = 30 * DAY_MS;
export const AGENTS_TTL_MS = 30 * DAY_MS;
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const BUCKET = /^[0-9a-f]{8}$/;
export const SKIP = [
	"hooks/daily-prune.stamp",
	"adhoc",
	"bg/*.pid",
	"pw/states",
	"pw/sessions",
	"pw/sock",
	"pw/log",
].map((pattern) => new Bun.Glob(pattern));
export const AGENTS_KEEP = [
	".agents/school/**",
	".agents/references/**",
	".agents/spec/**",
	".agents/decisions/**",
	".agents/monolith.md",
	".agents/monolith/**",
	".agents/jot/**",
	".agents/paths.md",
	"**/HANDOFF.md",
].map((pattern) => new Bun.Glob(pattern));

export interface PruneOptions {
	now: number;
	dryRun: boolean;
	log: (line: string) => void;
	run: CommandRunner;
}

function lstatOrNull(p: string): Stats | null {
	try {
		return lstatSync(p);
	} catch {
		return null;
	}
}

function readdirOrEmpty(p: string): string[] {
	try {
		return readdirSync(p);
	} catch {
		return [];
	}
}

function newestMtime(p: string, cutoff: number): number {
	const stat = lstatOrNull(p);
	if (!stat) return 0;
	if (!stat.isDirectory() || stat.mtimeMs >= cutoff) return stat.mtimeMs;
	let newest = stat.mtimeMs;
	for (const child of readdirOrEmpty(p)) {
		newest = Math.max(newest, newestMtime(path.join(p, child), cutoff));
		if (newest >= cutoff) return newest;
	}
	return newest;
}

function remove(p: string, reason: string, opts: PruneOptions): void {
	opts.log(`${opts.dryRun ? "would remove" : "removed"} ${p} (${reason})`);
	if (!opts.dryRun) rmSync(p, { recursive: true, force: true });
}

function skipped(rel: string): boolean {
	return SKIP.some((glob) => glob.match(rel));
}

/** Removes entries past the TTL under each tool dir of a root. */
export function pruneRoot(
	root: string,
	ttlMs: number,
	flatFiles: boolean,
	opts: PruneOptions,
): void {
	if (!existsSync(root)) return;
	const cutoff = opts.now - ttlMs;
	for (const tool of readdirOrEmpty(root)) {
		const toolDir = path.join(root, tool);
		if (skipped(tool)) continue;
		const toolStat = lstatOrNull(toolDir);
		if (!toolStat) continue;
		if (!toolStat.isDirectory()) {
			if (flatFiles && toolStat.mtimeMs < cutoff)
				remove(toolDir, "flat file past TTL", opts);
			continue;
		}
		let removed = 0;
		for (const entry of readdirOrEmpty(toolDir)) {
			const p = path.join(toolDir, entry);
			if (
				skipped(`${tool}/${entry}`) ||
				!lstatOrNull(p) ||
				newestMtime(p, cutoff) >= cutoff
			)
				continue;
			remove(
				p,
				BUCKET.test(entry) ? "bucket past TTL" : "global entry past TTL",
				opts,
			);
			removed++;
		}
		if (removed > 0 && !opts.dryRun && readdirOrEmpty(toolDir).length === 0)
			remove(toolDir, "empty tool dir", opts);
	}
}

function git(args: string[], cwd: string): string | null {
	const r = Bun.spawnSync(["git", ...args], { cwd, stderr: "ignore" });
	return r.exitCode === 0 ? r.stdout.toString() : null;
}

/** Main repos that own a linked worktree under `worktreeRoot`. */
export function mainReposFor(worktreeRoot: string): string[] {
	if (!existsSync(worktreeRoot)) return [];
	const repos = new Set<string>();
	for (const entry of readdirSync(worktreeRoot)) {
		const dotGit = path.join(worktreeRoot, entry, ".git");
		if (!existsSync(dotGit) || !statSync(dotGit).isFile()) continue;
		const match = readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)$/m);
		const common = match?.[1]?.trim().match(/^(.*)\/\.git\/worktrees\/[^/]+$/);
		if (common?.[1] && existsSync(common[1])) repos.add(common[1]);
	}
	return [...repos].sort();
}

interface LinkedWorktree {
	path: string;
	branch: string;
}

function linkedWorktrees(repo: string): LinkedWorktree[] {
	const out = git(["worktree", "list", "--porcelain"], repo);
	if (!out) return [];
	return out
		.split("\n\n")
		.slice(1)
		.flatMap((block) => {
			const path = block.match(/^worktree (.+)$/m)?.[1];
			const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1];
			return path && branch ? [{ path, branch }] : [];
		});
}

/** Linked worktree branches of `repo`; the main worktree and detached trees are left out. */
export function linkedBranches(repo: string): string[] {
	return linkedWorktrees(repo).map((w) => w.branch);
}

function isUnder(child: string, root: string): boolean {
	const rel = path.relative(root, child);
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Prunes then removes linked worktrees under `worktreeRoot`; refused removals stay. */
export async function pruneWorktrees(
	worktreeRoot: string,
	opts: PruneOptions,
): Promise<void> {
	const root = existsSync(worktreeRoot)
		? realpathSync(worktreeRoot)
		: worktreeRoot;
	for (const repo of mainReposFor(worktreeRoot)) {
		if (opts.dryRun) {
			opts.log(
				`would check ${linkedBranches(repo).length} worktree(s) in ${repo}`,
			);
			continue;
		}
		const pruned = await opts.run(selfCommand(["worktree", "prune"]), {
			cwd: repo,
		});
		if (pruned.status !== 0) {
			const detail = pruned.stderr.trim().split("\n").pop()?.replace(ANSI, "");
			opts.log(`worktree prune failed in ${repo}: ${detail ?? ""}`);
			continue;
		}
		const inside = linkedWorktrees(repo).filter((w) =>
			isUnder(existsSync(w.path) ? realpathSync(w.path) : w.path, root),
		);
		for (const { branch } of inside) {
			const r = await opts.run(selfCommand(["worktree", "remove", branch]), {
				cwd: repo,
			});
			const detail = r.stderr.trim().split("\n").pop()?.replace(ANSI, "");
			opts.log(
				r.status === 0
					? `removed worktree ${repo} ${branch}`
					: `kept worktree ${repo} ${branch}: ${detail ?? ""}`,
			);
		}
	}
}

/** Main repos found as `<codeRoot>/*` directories that hold a `.git` directory. */
export function scanMainRepos(codeRoot: string): string[] {
	if (!existsSync(codeRoot)) return [];
	return readdirSync(codeRoot)
		.map((entry) => path.join(codeRoot, entry))
		.filter((dir) => {
			const dotGit = path.join(dir, ".git");
			return existsSync(dotGit) && statSync(dotGit).isDirectory();
		})
		.sort();
}

/** Every worktree path of `repo`: main, linked, and detached. */
export function worktreesOf(repo: string): string[] {
	const out = git(["worktree", "list", "--porcelain"], repo);
	if (!out) return [];
	return out
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length).trim());
}

function removeEmptyDirs(worktree: string, start: string): void {
	const stop = path.join(worktree, ".agents");
	for (
		let dir = start;
		dir.startsWith(`${stop}${path.sep}`) && dir !== stop;
		dir = path.dirname(dir)
	) {
		if (
			!existsSync(dir) ||
			readdirSync(dir).length > 0 ||
			git(["check-ignore", "-q", dir], worktree) === null
		)
			return;
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Deletes stale git-ignored files under a worktree .agents dir. */
export function pruneAgentsDir(worktree: string, opts: PruneOptions): void {
	if (!existsSync(path.join(worktree, ".agents"))) return;
	const listing = git(
		[
			"ls-files",
			"--others",
			"--ignored",
			"--exclude-standard",
			"-z",
			"--",
			".agents",
		],
		worktree,
	);
	if (!listing) return;
	const cutoff = opts.now - AGENTS_TTL_MS;
	for (const rel of listing.split("\0").filter(Boolean)) {
		const segments = rel.split("/");
		if (
			segments[0] !== ".agents" ||
			segments.includes(".git") ||
			segments.includes("..")
		)
			continue;
		if (AGENTS_KEEP.some((glob) => glob.match(rel))) continue;
		const p = path.join(worktree, rel);
		const stat = lstatOrNull(p);
		if (!stat || stat.isDirectory() || stat.mtimeMs >= cutoff) continue;
		remove(p, "ignored .agents file past TTL", opts);
		if (!opts.dryRun) removeEmptyDirs(worktree, path.dirname(p));
	}
}

/** Prunes .agents in every worktree of the repos. */
export function pruneAgents(repos: string[], opts: PruneOptions): void {
	const seen = new Set<string>();
	for (const repo of repos) {
		for (const worktree of worktreesOf(repo)) {
			if (seen.has(worktree) || !existsSync(worktree)) continue;
			seen.add(worktree);
			pruneAgentsDir(worktree, opts);
		}
	}
}

export function stampFresh(stamp: string, now: number): boolean {
	return existsSync(stamp) && now - statSync(stamp).mtimeMs < DAY_MS;
}

/** The background job: prunes scratch, state, worktrees and `.agents`, then writes the log. */
export async function runNow(
	env: HookEnv,
	run: CommandRunner,
	dryRun: boolean,
	log: (line: string) => void = (line) =>
		void process.stdout.write(`${line}\n`),
): Promise<void> {
	const lines: string[] = [];
	const opts: PruneOptions = {
		now: Date.now(),
		dryRun,
		run,
		log: (line) => {
			lines.push(line);
			log(line);
		},
	};
	opts.log(
		`daily-prune ${new Date(opts.now).toISOString()}${dryRun ? " dry-run" : ""}`,
	);
	const phase = async (name: string, work: () => void | Promise<void>) => {
		try {
			await work();
		} catch (error) {
			opts.log(
				`${name} failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};
	const codeRoot = env["DAILY_PRUNE_CODE_ROOT"];
	const worktreeRoot =
		env["DAILY_PRUNE_WORKTREE_ROOT"] ??
		path.join(codeRoot ?? path.join(homedir(), "code"), "worktrees");
	await phase("scratch prune", () =>
		pruneRoot(scratchRoot(env), SCRATCH_TTL_MS, true, opts),
	);
	await phase("state prune", () =>
		pruneRoot(stateRoot(env), STATE_TTL_MS, false, opts),
	);
	await phase("worktree prune", () => pruneWorktrees(worktreeRoot, opts));
	await phase("agents prune", () =>
		pruneAgents(
			[
				...new Set([
					...mainReposFor(worktreeRoot),
					...(codeRoot ? scanMainRepos(codeRoot) : []),
				]),
			].sort(),
			opts,
		),
	);
	if (dryRun) return;
	const logDir = path.join(scratchRoot(env), "hooks");
	mkdirSync(logDir, { recursive: true });
	writeFileSync(path.join(logDir, "daily-prune.log"), `${lines.join("\n")}\n`);
}

const LOCK_STALE_MS = 10 * 60_000;

function takeLock(lock: string): boolean {
	try {
		writeFileSync(lock, String(process.pid), { flag: "wx" });
		return true;
	} catch {
		try {
			if (Date.now() - statSync(lock).mtimeMs < LOCK_STALE_MS) return false;
			rmSync(lock, { force: true });
			writeFileSync(lock, String(process.pid), { flag: "wx" });
			return true;
		} catch {
			return false;
		}
	}
}

const handler: HookHandler = async (_input, ctx) => {
	const stamp = path.join(ctx.stateDir, "daily-prune.stamp");
	if (stampFresh(stamp, Date.now())) return { exitCode: 0 };
	mkdirSync(path.dirname(stamp), { recursive: true });
	const lock = `${stamp}.lock`;
	if (!takeLock(lock)) return { exitCode: 0 };
	try {
		if (stampFresh(stamp, Date.now())) return { exitCode: 0 };
		const previous = existsSync(stamp) ? statSync(stamp).mtime : undefined;
		writeFileAtomic(stamp, "");
		try {
			ctx.seams.spawnDetached(
				selfCommand(["hooks", "run", "daily-prune", "--now"]),
			);
		} catch (error) {
			if (previous) utimesSync(stamp, previous, previous);
			else rmSync(stamp, { force: true });
			throw error;
		}
		return { exitCode: 0 };
	} finally {
		rmSync(lock, { force: true });
	}
};

export default handler;
