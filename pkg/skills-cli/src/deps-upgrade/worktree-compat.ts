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
import { runCapture } from "@dg/common/node";

/** Create-only seam reused by the future worktree lifecycle command. */
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

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function git(
	cwd: string,
	args: string[],
	reportDiagnostic?: (text: string) => void,
): Promise<string> {
	const result = await runCapture("git", ["-C", cwd, ...args], { stdin: null });
	if (result.stdout) reportDiagnostic?.(result.stdout);
	if (result.stderr) reportDiagnostic?.(result.stderr);
	if (result.status !== 0)
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
		let entries;
		try {
			entries = readdirSync(path.join(source, relative), {
				withFileTypes: true,
			});
		} catch (error) {
			warn(`could not read ${relative || "."} for seeding: ${errorMessage(error)}`);
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
	const warn = (message: string): void =>
		reportDiagnostic(`worktree-cli: ${message}\n`);
	const info = (message: string): void => reportDiagnostic(`${message}\n`);
	const slug = options.slug
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_|_$/g, "");
	if (!slug) throw new Error("slug normalized to empty string");
	const cwd = path.resolve(options.cwd ?? process.cwd());
	let listing: string;
	try {
		listing = await git(cwd, ["worktree", "list", "--porcelain"]);
	} catch {
		throw new Error("not in a git repo (run from within the repo)");
	}
	const origin = listing.match(/^worktree (.+)$/m)?.[1];
	if (!origin) throw new Error("not in a git repo");
	const prefix = options.prefix ?? "feature/";
	const branch = `${prefix.endsWith("/") ? prefix : `${prefix}/`}${slug}`;
	const homeCode = path.join(process.env.HOME ?? homedir(), "code");
	const parent = origin.startsWith(`${homeCode}${path.sep}`)
		? path.join(homeCode, "worktrees")
		: path.dirname(origin);
	let target = path.join(parent, `${path.basename(origin)}-${slug}`);
	let base = options.base;
	if (!base) {
		try {
			base = (await git(origin, ["symbolic-ref", "refs/remotes/origin/HEAD"]))
				.trim()
				.replace(/^refs\/remotes\/origin\//, "");
		} catch {}
		if (!base)
			throw new Error(
				`could not resolve origin/HEAD; run: git -C ${origin} remote set-head origin -a`,
			);
	}
	if ((await git(origin, ["status", "--porcelain"])).trim())
		warn(
			"main repo has uncommitted changes — NOT carried into worktree. Stash if needed.",
		);
	if ((await git(origin, ["status", "--porcelain", "--", ".agents/"])).trim())
		warn(
			"uncommitted .agents/ changes won't be visible in the worktree until merged.",
		);
	let hasBranch = false;
	try {
		await git(origin, [
			"rev-parse",
			"--verify",
			"--quiet",
			`refs/heads/${branch}`,
		]);
		hasBranch = true;
	} catch {}
	const hasPath = existsSync(target);
	if (options.resume === false && (hasBranch || hasPath))
		throw new Error(
			`state exists (branch=${Number(hasBranch)} path=${Number(hasPath)}) and --no-resume was passed`,
		);
	if (hasBranch && hasPath) {
		const existing = listing
			.split("\n\n")
			.find((block) =>
				block.split("\n").includes(`branch refs/heads/${branch}`),
			)
			?.match(/^worktree (.+)$/m)?.[1];
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
			await git(origin, ["worktree", "add", target, branch], reportDiagnostic);
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
			await git(origin, ["fetch", "origin", base], reportDiagnostic);
		} catch {
			warn(`fetch origin/${base} failed — proceeding with local ref`);
		}
		info(`creating worktree: ${target} (branch ${branch} from origin/${base})`);
		mkdirSync(parent, { recursive: true });
		try {
			await git(
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
