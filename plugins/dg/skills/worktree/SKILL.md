---
name: worktree
description: "Manage git worktrees for AI agent workflows — create, list, remove, prune. Reused by the planning and execution skills."
---

# /dg:worktree — Git Worktree Lifecycle

Front door for git worktree management. Reused by planning and execution workflows for worktree creation; permissions, frontmatter, PR and cwd restore stay in those workflows.

First run: install or refresh the CLI when it is missing or too old. Every later call uses the literal path, so each Bash call works alone:

```bash
~/.dg/bin/dg-skills worktree --help >/dev/null 2>&1 ||
  curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.18.1/pkg/skills-cli/bootstrap.sh | sh -s -- --cli-only
```

If a step fails, run ~/.dg/bin/dg-skills doctor worktree.

## Usage

**Usage:** `/dg:worktree create <slug> [-p <prefix>] [-b <branch>] [-N] [--no-resume] | list [--porcelain] | remove <slug> [--force] [--keep-branch] [--merged-ok] | prune`

```sh
# create or resume a worktree+branch (slug positional)
~/.dg/bin/dg-skills worktree create <slug> [--prefix feature/] [--base <branch>] [--no-seed] [--no-resume]

# list linked worktrees (STATUS: clean, dirty, ahead N, no-upstream, MISSING)
~/.dg/bin/dg-skills worktree list [--porcelain]

# remove a worktree + branch (guards block by default)
~/.dg/bin/dg-skills worktree remove <slug> [--force] [--keep-branch] [--merged-ok]

# clean up stale records (paths missing on disk)
~/.dg/bin/dg-skills worktree prune
```

Run `~/.dg/bin/dg-skills worktree <subcommand> --help` for per-subcommand details. A bare `~/.dg/bin/dg-skills worktree` prints usage on stderr and exits 1; failures exit 2.

## Flags

| Flag | Short | Effect | Default |
|---|---|---|---|
| `--prefix <str>` | `-p` | create: branch prefix. | `feature/` |
| `--base <branch>` | `-b` | create: base branch. | `origin/HEAD` |
| `--no-seed` | `-N` | create: skip copying `.env`, `.envrc`, `.tool-versions` and similar files. | off |
| `--no-resume` | none | create: error if the branch or path already exists. | off |
| `--porcelain` | `-p` | list: machine-readable output. | off |
| `--force` | `-f` | remove: override all safety guards (uncommitted changes, unpushed commits, unmerged branch). | off |
| `--keep-branch` | `-k` | remove: remove the worktree and keep the local branch. | off |
| `--merged-ok` | `-m` | remove: skip only the merged-into-base guard. | off |

## Output contract

`create` emits exactly three KEY=value lines on stdout. Consume with:

```sh
eval "$(~/.dg/bin/dg-skills worktree create my_feature)"
```

`WORKTREE_PATH`, `WORKTREE_BRANCH` and `WORKTREE_ORIGIN` are now in the environment. All warnings, errors and progress go to stderr, so stdout stays clean for machine consumption. Create output is eval-safe: a value made only of shell-safe characters prints raw, and any other value (spaces, quotes, `$`) is single-quoted. `list --porcelain` values are raw and never quoted; parsers split each line on the first `=`.

## Working in the worktree (no session relocation)

`create` only makes the worktree on disk. It never changes cwd, and the session cannot relocate into it. `EnterWorktree({path: <WORKTREE_PATH>})` refuses these paths: the `path` form accepts only worktrees registered under `<repo>/.claude/worktrees/`, and this command places worktrees at `$HOME/code/worktrees/<repo>-<slug>` (or beside origin).

The session stays put. Every command that needs the worktree carries its own `cd`:

```sh
cd "$WORKTREE_PATH" && git status --porcelain
```

The shell's cwd does not persist between tool calls, so prefix every command that must run in the worktree. `ExitWorktree` has no role here; teardown goes through `~/.dg/bin/dg-skills worktree remove`.

## Path & branch conventions

- Branch: `feature/<slug>` (override with `--prefix`; `-p` and `-b` alias `--prefix` and `--base`).
- Path: `$HOME/code/worktrees/<repo>-<slug>` when origin is under `~/code/`, otherwise a sibling of origin (`<dirname>/<repo>-<slug>`).
- Slugs are normalized: lowercase, `[^a-z0-9]+` becomes `_`.

## Seeded files (skip with `--no-seed` or `-N`)

Copied from origin into the new worktree, preserving mode:

- `.env`, `.env.*`
- `.envrc`
- `.tool-versions`, `.nvmrc`
- `.python-version`, `.node-version`, `.ruby-version`, `.terraform-version`
- `.env` and `.env.*` files one and two directories down (never `node_modules`)

## Remove safety guards

`remove <slug>` accepts the slug or the full branch name. An ambiguous slug lists every candidate and removes nothing. These guards block by default; `--force` overrides all of them:

1. Uncommitted changes or untracked files.
2. Unpushed commits ahead of upstream (no upstream: blocked when ahead of `origin/<base>`).
3. Branch not merged into `origin/<base>`: `git cherry` first (squash-aware), then a merged pull request lookup through the provider. A failed lookup is reported as `lookup failed` and blocks; a missing provider CLI blocks silently.

A failed status or comparison check blocks removal; it never counts as clean. `--merged-ok` skips guard 3 only, as `/dg:address` does after the provider confirms a merge. `--keep-branch` leaves the local branch (default is `git branch -D`); a failed branch delete warns and still exits 0. If `git worktree remove` fails (for example a locked worktree), the command exits 2 and keeps the worktree, directory and branch.

## Resume semantics (permissive)

| State | Behavior |
|---|---|
| Branch + path both exist | Resume, emit KEY=values |
| Branch exists, path missing | Recreate worktree at expected path from branch HEAD |
| Path exists, branch missing | Error — investigate manually |
| Branch exists, path is a plain directory (not a worktree of that branch) | Error (exit 2), nothing created — investigate manually |
| Dirty worktree on resume | Succeed — caller decides |

Pass `--no-resume` to make any partial state an error.
