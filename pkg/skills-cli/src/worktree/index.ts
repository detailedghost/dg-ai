import { create } from "./create";
import { list } from "./list";
import { prune } from "./prune";
import { remove } from "./remove";
import { WorktreeError } from "./shared";

export const USAGE = `worktree-cli — git worktree lifecycle for AI agent workflows

USAGE
  dg-skills worktree <subcommand> [args]

SUBCOMMANDS
  create <slug>    Create or resume a worktree+branch.
                   Emits WORKTREE_PATH/BRANCH/ORIGIN on stdout.
  list             List linked worktrees (--porcelain for KEY=value blocks).
  remove <slug>    Remove a worktree + branch, with safety guards.
  prune            Clean up stale worktree records.

  Run \`dg-skills worktree <subcommand> --help\` for per-subcommand flags.

OUTPUT
  \`create\` emits exactly three lines on stdout — consume with:
      eval "$(dg-skills worktree create my_feature)"
  All warnings/errors/progress go to stderr.
`;

const SUBCOMMANDS = new Map<string, (args: string[]) => Promise<number>>([
	["create", create],
	["list", list],
	["ls", list],
	["remove", remove],
	["rm", remove],
	["prune", prune],
]);

/** Dispatch a worktree subcommand; failures print `worktree-cli: <message>` and return 2. */
export async function main(argv: string[]): Promise<number> {
	const [sub, ...rest] = argv;
	if (sub === undefined) {
		process.stderr.write(USAGE);
		return 1;
	}
	if (sub === "-h" || sub === "--help" || sub === "help") {
		process.stdout.write(USAGE);
		return 0;
	}
	const handler = SUBCOMMANDS.get(sub);
	try {
		if (!handler)
			throw new WorktreeError(`unknown subcommand: ${sub} (try --help)`);
		return await handler(rest);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`worktree-cli: ${message}\n`);
		return 2;
	}
}
