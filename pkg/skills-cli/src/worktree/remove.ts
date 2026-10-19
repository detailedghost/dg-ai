import { existsSync } from "node:fs";
import { getProvider } from "../provider/index";
import { ProviderError, type ProviderErrorCode } from "../provider/types";
import { slugify } from "./core";
import {
	branchExists,
	fail,
	git,
	info,
	lastSegment,
	listWorktrees,
	originBase,
	warn,
} from "./shared";

export const REMOVE_HELP = `worktree remove <slug> [flags]

  Remove a worktree and its branch. Blocks on safety guards by default.

Guards (all overridable with --force):
  * Uncommitted changes or untracked files in the worktree
  * Unpushed commits ahead of upstream
  * Branch not merged into origin/<base> (git cherry + provider fallback)

Flags:
  -f, --force         Override all safety guards.
  -k, --keep-branch   Remove the worktree but keep the local branch.
  -m, --merged-ok     Skip the merged-into-base guard (used by /address
                      post-merge cleanup since the provider already confirmed merge).
  -h, --help          This help.
`;

interface RemoveOptions {
	force: boolean;
	keepBranch: boolean;
	mergedOk: boolean;
	slug: string;
}

function parse(args: string[]): RemoveOptions | null {
	const options = {
		force: false,
		keepBranch: false,
		mergedOk: false,
		slug: "",
	};
	let slug: string | undefined;
	for (const arg of args) {
		if (arg === "-h" || arg === "--help") return null;
		if (arg === "-f" || arg === "--force") options.force = true;
		else if (arg === "-k" || arg === "--keep-branch") options.keepBranch = true;
		else if (arg === "-m" || arg === "--merged-ok") options.mergedOk = true;
		else if (arg.startsWith("-")) fail(`unknown flag for remove: ${arg}`);
		else if (slug === undefined) slug = arg;
		else fail("remove takes one slug positional");
	}
	if (slug === undefined) fail("remove requires a slug");
	options.slug = slugify(slug);
	return options;
}

const NO_PROVIDER_CODES: ReadonlySet<ProviderErrorCode> = new Set([
	"GH_NOT_FOUND",
	"GLAB_NOT_FOUND",
	"HOST_NOT_RECOGNIZED",
	"NO_REMOTE",
	"NO_GIT_REPO",
]);

async function mergedPullRequestExists(
	repo: string,
	branch: string,
): Promise<boolean> {
	const previous = process.cwd();
	process.chdir(repo);
	try {
		const provider = await getProvider();
		const matches = await provider.listPullRequests({
			head: branch,
			state: "MERGED",
		});
		return matches.length > 0;
	} catch (error) {
		if (error instanceof ProviderError && NO_PROVIDER_CODES.has(error.code))
			return false;
		warn(`provider lookup failed for ${branch} — treating as not merged`);
		return false;
	} finally {
		process.chdir(previous);
	}
}

async function isBranchMerged(
	repo: string,
	branch: string,
	base: string,
): Promise<boolean> {
	const cherry = await git(repo, ["cherry", `origin/${base}`, branch]);
	if (!cherry.ok)
		fail(
			`could not compare ${branch} with origin/${base} (git cherry failed). Use --merged-ok or --force.`,
		);
	const unmerged = cherry.stdout
		.split("\n")
		.some((line) => line.startsWith("+"));
	return !unmerged || (await mergedPullRequestExists(repo, branch));
}

async function checkCleanAndPushed(repo: string, path: string): Promise<void> {
	const status = await git(path, ["status", "--porcelain"]);
	if (!status.ok)
		fail("could not read worktree status. Use --force to override.");
	if (status.stdout.trim())
		fail(
			"worktree has uncommitted changes or untracked files. Use --force to override.",
		);
	const upstream = await git(path, ["rev-parse", "--abbrev-ref", "@{u}"]);
	if (upstream.ok) {
		const ahead = await git(path, ["rev-list", "--count", "@{u}..HEAD"]);
		if (!ahead.ok)
			fail("could not count unpushed commits. Use --force to override.");
		const count = Number.parseInt(ahead.stdout, 10);
		if (count > 0)
			fail(
				`worktree has ${count} unpushed commit(s). Use --force to override.`,
			);
		return;
	}
	const base = await originBase(repo);
	if (!base) return;
	const head = await git(path, ["rev-list", "--count", "HEAD"]);
	if (!head.ok)
		fail("could not count branch commits. Use --force to override.");
	const baseCount = await git(path, ["rev-list", "--count", `origin/${base}`]);
	if (
		Number.parseInt(head.stdout, 10) >
		(baseCount.ok ? Number.parseInt(baseCount.stdout, 10) : 0)
	)
		fail(
			`branch has no upstream and is ahead of origin/${base}. Use --force to override.`,
		);
}

export async function remove(args: string[]): Promise<number> {
	const options = parse(args);
	if (!options) {
		process.stdout.write(REMOVE_HELP);
		return 0;
	}
	const [origin, ...linked] = await listWorktrees(process.cwd());
	const repo = origin?.path ?? process.cwd();
	const matches = linked.filter(
		(entry): entry is { path: string; branch: string } =>
			entry.branch !== null &&
			(slugify(lastSegment(entry.branch)) === options.slug ||
				slugify(entry.branch) === options.slug),
	);
	const [target] = matches;
	if (!target) fail(`no worktree found for slug: ${options.slug}`);
	if (matches.length > 1)
		fail(
			`slug '${options.slug}' is ambiguous:\n${matches
				.map((entry) => `  ${entry.branch} (${entry.path})`)
				.join("\n")}\nPass the full branch name to disambiguate.`,
		);
	const { path, branch } = target;
	info(`target: ${path} (branch ${branch})`);

	if (!options.force) {
		if (existsSync(path)) await checkCleanAndPushed(repo, path);
		if (!options.mergedOk) {
			const base = await originBase(repo);
			if (!base)
				fail(
					"could not resolve origin/HEAD for merged-check. Use --merged-ok or --force.",
				);
			if (!(await isBranchMerged(repo, branch, base)))
				fail(
					`branch ${branch} is not merged into origin/${base} (per git cherry + provider fallback). Use --merged-ok or --force.`,
				);
		}
	}

	if (existsSync(path)) {
		info(`removing worktree at ${path}`);
		const removal = await git(repo, [
			"worktree",
			"remove",
			...(options.force ? ["--force"] : []),
			path,
		]);
		if (!removal.ok) fail(`worktree remove failed: ${removal.stderr.trim()}`);
	} else {
		info(`path ${path} already gone — pruning record`);
		await git(repo, ["worktree", "prune"]);
	}

	if (!options.keepBranch && (await branchExists(repo, branch))) {
		info(`deleting branch ${branch}`);
		const deletion = await git(repo, ["branch", "-D", branch]);
		if (!deletion.ok) {
			warn(`branch delete failed (continuing): ${deletion.stderr.trim()}`);
			info(`removed worktree; kept branch: ${branch}`);
			return 0;
		}
	}
	info(`removed: ${branch}`);
	return 0;
}
