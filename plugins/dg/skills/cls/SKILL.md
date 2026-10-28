---
name: cls
description: Close out the current git worktree. Remove the worktree and local branch, sweep leftover scratch assets, and return to the main repo on the default branch. Use when finishing or abandoning work in a worktree, or run `/dg:cls <slug>` from the main repo to tear down a specific worktree. When invoked from the main repo on a non-default branch (no slug), switches to the default branch and deletes the branch you came from.
---

# /dg:cls: Close out a worktree

First run: install or refresh the CLI when it is missing or too old. Every later call uses the literal path, so each Bash call works alone:

```bash
~/.dg/bin/dg-skills bg --help >/dev/null 2>&1 ||
  curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh -s -- --cli-only
```

If a step fails, run ~/.dg/bin/dg-skills doctor bg stash vcs-provider worktree.

Thin orchestration over `~/.dg/bin/dg-skills worktree remove` (linked worktrees, plus a defensive `ExitWorktree({action:"keep"})` first in case `/dg:sdlc` or `/dg:spec` entered one with `EnterWorktree(path=...)`) and `ExitWorktree` (harness sessions). Guards never force-remove unmerged or dirty work without asking.

> **Statusline note.** Only `ExitWorktree` or a focus-file rewrite moves the statusline. A `cd` does not. A bare `cd "$MAIN"` keeps Bash calls off a deleted path but does not repoint the user's terminal.

## Usage

**Usage:** `/dg:cls [<slug>] [--force] [--keep-branch] [--keep-assets]`

With no arguments, `/dg:cls` closes out the worktree the session is in. From the main repo it switches to the default branch and deletes the branch you came from. By default it lands on the default branch and fast-forwards it to origin (`--ff-only`), so the local default does not lag merged PRs. By default it also prunes stale branches: it safe-deletes the clearly safe ones and asks before force-deleting any with local-only commits. A dirty main repo, `--keep-branch`, or a checkout that is not on the default branch skips these steps; see Step 2D and 2E in `references/steps.md`.

## Flags

| Flag | Short | Effect | Default |
|---|---|---|---|
| `<slug>` | none | From the main repo, tear down the worktree for that slug. | current worktree |
| `--force` | none | Override the dirty, unpushed and unmerged guards (asks first). Also covers an unmerged-branch delete in the main-repo case and pre-authorizes force-deletes in the stale-branch sweep. Every force-deleted branch is still reported. | off |
| `--keep-branch` | none | Remove the worktree, keep the local branch. Also skips all deletions in the stale-branch sweep and reports the candidates it would have removed. | off |
| `--keep-assets` | none | Skip the scratch sweep. | off |

## Routing

| Task | Read |
|---|---|
| Capture the context variables (`KIND`, `MAIN`, `BRANCH`, `BUCKET`, `DEFAULT`) | [references/detect.md](references/detect.md) |
| Steps 2A, 2B and 2C (harness, linked, main repo), landing (2D), pruning (2E), sweep (3), report (4) | [references/steps.md](references/steps.md) |
