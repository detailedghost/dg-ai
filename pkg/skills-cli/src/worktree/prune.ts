import { fail, git, info, listWorktrees } from "./shared";

export const PRUNE_HELP = `worktree prune

  Clean up stale worktree records (paths that no longer exist on disk).
  Thin wrapper over \`git worktree prune -v\`.

Flags:
  -h, --help   This help.
`;

async function prunableCount(repo: string): Promise<number> {
	const result = await git(repo, ["worktree", "list", "--porcelain"]);
	return result.stdout.split("\n").filter((line) => line.startsWith("prunable"))
		.length;
}

export async function prune(args: string[]): Promise<number> {
	for (const arg of args) {
		if (arg === "-h" || arg === "--help") {
			process.stdout.write(PRUNE_HELP);
			return 0;
		}
		fail(`unknown arg for prune: ${arg}`);
	}
	const [origin] = await listWorktrees(process.cwd());
	const repo = origin?.path ?? process.cwd();
	const before = await prunableCount(repo);
	const result = await git(repo, ["worktree", "prune", "-v"]);
	process.stderr.write(result.stdout + result.stderr);
	if (!result.ok) fail("git worktree prune failed");
	const reclaimed = before - (await prunableCount(repo));
	info(
		reclaimed > 0
			? `pruned ${reclaimed} stale worktree record(s)`
			: "nothing to prune",
	);
	return 0;
}
