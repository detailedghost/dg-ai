import { createWorktree } from "./core";
import { fail, shellValue } from "./shared";

export const CREATE_HELP = `worktree create <slug> [flags]

  Create a worktree+branch, or resume an existing one. Emits KEY=value on stdout:
    WORKTREE_PATH=<abs>
    WORKTREE_BRANCH=<name>
    WORKTREE_ORIGIN=<abs>

  Consume with: eval "$(dg-skills worktree create my_feature)"

Flags:
  -p, --prefix <str>   Branch prefix (default: feature/)
  -b, --base <branch>  Base branch (default: origin/HEAD)
  -N, --no-seed        Skip copying .env/.envrc/.tool-versions/etc.
      --no-resume      Error if branch or path already exists.
  -h, --help           This help.
`;

export async function create(args: string[]): Promise<number> {
	let prefix: string | undefined;
	let base: string | undefined;
	let seed = true;
	let resume = true;
	let slug: string | undefined;
	const value = (flag: string, next: string | undefined): string =>
		next === undefined ? fail(`${flag} requires a value`) : next;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (arg === "-h" || arg === "--help") {
			process.stdout.write(CREATE_HELP);
			return 0;
		}
		if (arg === "-p" || arg === "--prefix") prefix = value(arg, args[++i]);
		else if (arg === "-b" || arg === "--base") base = value(arg, args[++i]);
		else if (arg === "-N" || arg === "--no-seed") seed = false;
		else if (arg === "--no-resume") resume = false;
		else if (arg.startsWith("-")) fail(`unknown flag for create: ${arg}`);
		else if (slug === undefined) slug = arg;
		else fail("create takes one slug positional");
	}
	if (slug === undefined)
		fail("create requires a slug (try: dg-skills worktree create my_feature)");
	const result = await createWorktree(
		{ slug, prefix, base, seed, resume },
		(text) => {
			process.stderr.write(text);
		},
	);
	process.stdout.write(
		`WORKTREE_PATH=${shellValue(result.path)}\nWORKTREE_BRANCH=${shellValue(result.branch)}\nWORKTREE_ORIGIN=${shellValue(result.origin)}\n`,
	);
	return 0;
}
