---
name: land
description: >-
  Take a ready GitHub PR to merged in one command. Run local review
  rounds through /dg:review-loop proxy mode (Codex by default), get CI
  green with /dg:address fixes, check the merge state, then ask the
  human before a squash merge at the tested head SHA. Use when a PR is
  ready and you want it reviewed, green, and merged — "land this",
  "get it merged". --no-merge stops at ready to merge.
---

<!-- markdownlint-disable MD013 MD041 MD060 -->

# /dg:land — From Ready to Merged

One command takes an open PR through review, CI, and the merge gate.
`/dg:review-loop` finds the issues. `/dg:address` fixes them. This skill
only orders the steps, waits for CI, and owns the merge gate.

**Usage:** `/dg:land [<pr-number|url>] [-r N] [--no-early-stop] [-c N] [-p <backend>] [-b <ref>] [-w <sec>] [--no-merge] [--squash|--merge|--rebase]`

## Flags

| Flag | Short | Effect | Default |
|---|---|---|---|
| `<pr-number\|url>` | none | The PR to land. | the PR of the current branch |
| `--rounds N` | `-r` | The number of review rounds this run adds. | `3` |
| `--no-early-stop` | none | Run all `N` rounds. Do not stop at the first dry round. | off |
| `--ci-retries N` | `-c` | The number of times to fix failing CI with `/dg:address`, push, and wait again. | `2` |
| `--proxy <backend>` | `-p` | The review backend, passed to `/dg:review-loop -p`. One of `codex`, `pi`, `opencode`, `grok`. `copilot` is refused. | `codex` |
| `--base <ref>` | `-b` | The diff base for the review rounds. | merge base with the PR's base branch |
| `--wait-timeout <sec>` | `-w` | The cap for each CI wait. | `1800` |
| `--no-merge` | none | Stop at "ready to merge" and print the merge command. | off |
| `--squash` | none | Merge method: squash. | the repo's method |
| `--merge` | none | Merge method: merge commit. | the repo's method |
| `--rebase` | none | Merge method: rebase. | the repo's method |

The repo's method is the only one the repo allows. When the repo allows
more than one, it is `--squash` when allowed. Every merge also deletes the remote branch.

## Runtime and skill paths

Resolve the compiled CLI before running any command:

```bash
dg-skills address --help >/dev/null 2>&1 ||
  "${DG_HOME:-$HOME/.local}/bin/dg-skills" address --help >/dev/null 2>&1 ||
  curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh -s -- --cli-only
```

Call `dg-skills` in every later step. If `dg-skills` alone does not answer, also after the bootstrap, call `${DG_HOME:-$HOME/.local}/bin/dg-skills` instead.

If a step fails, run dg-skills doctor address proxy vcs-provider.

Repeat this resolution in every fresh shell, including delegated execution and
resumed commands; shell variables do not persist between tool calls. Use the
host's existing narrow approvals for the specific operation and honor permission
already granted in this session. Do not edit permission files or assume that the
compiled binary grants blanket approval to its subcommands.

Resolve cross-skill instructions from this installed tree using sibling paths
(`../<skill>/SKILL.md` from this directory, `../../<skill>/SKILL.md` from
`references/`). If an unmigrated skill is missing, use only an explicitly
configured personal skill root (`DG_PERSONAL_SKILLS_DIR/<skill>/SKILL.md`).
Report missing instructions; never assume a private checkout or cache location.

## Flow

| # | Step | Stops when |
|---|---|---|
| 1 | Resolve the PR, its head SHA, its base, and its checkout. | not GitHub, draft, closed, fork, stacked, no checkout, local and remote heads differ |
| 2 | `/dg:review-loop -p <backend>` for `N` rounds. `/dg:address` fixes and pushes. | review-loop fails |
| 3 | Wait for CI on the new head. On failure, `/dg:address` fixes it, up to `-c` times. | CI still red, or the wait times out |
| 4 | Check the merge state. | behind, conflicting, or blocked: suggest `/dg:catchup` or report |
| 5 | Merge gate in the main loop: ask, then merge at the tested SHA. | the human says no, `--no-merge`, or the harness blocks the merge |
| 6 | Check the PRs that used the deleted branch as their base. | never |
| 7 | Final report. | never |

Read [references/workflow.md](references/workflow.md) for each step's commands and gates.

## Rules

- **GitHub only.** The merge, CI wait, and merge state use `gh`. On GitLab, stop and say so.
- **Never Copilot.** Refuse `-p copilot` before any step. Never request a GitHub Copilot review.
- **Only the main loop merges.** A subagent, a slice wave, or a `/dg:spec --bg` run never runs `gh pr merge`. It stops at step 5 and reports the summary and the merge command.
- **Never work around a blocked merge.** When the harness or a hook blocks `gh pr merge`, print the exact command with a `!` prefix for the human to run, and stop.
- **Merge only the tested head.** Always pass `--match-head-commit <sha>`, where `<sha>` is the head that CI passed on.
- **Do not resolve conflicts here.** A behind or conflicting PR goes to `/dg:catchup`. A stacked PR goes to its parent first, or to `/dg:chain`.
- **Edit nothing directly.** All code changes happen inside `/dg:address`.
