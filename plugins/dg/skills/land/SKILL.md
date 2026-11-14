---
name: land
description: >-
  Take a ready GitHub PR to "ready for your review" in one command.
  Run local review rounds through /dg:review-loop proxy mode (Codex by
  default), get CI green with /dg:address fixes, check the merge state,
  open the PR, then ask before a merge at the tested head SHA. "Not
  yet" is the default answer. --auto merges right after green CI with
  no review stop. Use when a PR is ready and you want it reviewed,
  green, and merged — "land this", "get it merged".
---

<!-- markdownlint-disable MD013 MD041 MD060 -->

# /dg:land — From Ready to Merged

One command takes an open PR through review and CI to "ready for your
review". The human looks at the PR, then answers the merge gate.
`/dg:review-loop` finds the issues. `/dg:address` fixes them. This skill
only orders the steps, waits for CI, and owns the merge gate.

**Usage:** `/dg:land [<pr-number|url>] [-r N] [--no-early-stop] [-c N] [-p <backend>] [-b <ref>] [-w <sec>] [--no-merge] [--auto] [--squash|--merge|--rebase]`

## Flags

| Flag | Short | Effect | Default |
|---|---|---|---|
| `<pr-number\|url>` | none | The PR to land. | the PR of the current branch |
| `--rounds N` | `-r` | The number of review rounds in each review loop. | `3` |
| `--no-early-stop` | none | Run all `N` rounds. Do not stop at the first dry round. | off |
| `--ci-retries N` | `-c` | The safety ceiling on CI-fix cycles. Each cycle fixes the failed checks with `/dg:address`, pushes, runs a review loop on the fix, and waits for CI again. `0` means no ceiling. | `5` |
| `--proxy <backend>` | `-p` | The review backend, passed to `/dg:review-loop -p`. One of `codex`, `pi`, `opencode`, `grok`. `copilot` is refused. | `codex` |
| `--base <ref>` | `-b` | The diff base for the review rounds. | merge base with the PR's base branch |
| `--wait-timeout <sec>` | `-w` | The cap for each CI wait. | `1800` |
| `--no-merge` | none | Stop at "ready for your review" with no question, and print the merge command. | off |
| `--auto` | none | `--auto` merges right after green CI, with no review stop. This is not GitHub auto-merge. Every other stop still applies. Only the person who types it turns it on. Invalid with `--no-merge`. | off (ask) |
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

If a step fails, run dg-skills doctor address batch-open proxy vcs-provider.

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
| 3 | Wait for CI. On a failed check, `/dg:address` fixes it, pushes, and step 2 reviews the fix; then wait again. Leave the loop only when CI is green on a reviewed head. | the `-c` ceiling, the same check failing twice with the same error, or a wait timeout |
| 4 | Check the merge state. | behind, conflicting, or blocked: suggest `/dg:catchup` or report |
| 5 | Ready for your review: summary, open the PR, then ask in the main loop. Merge at the tested SHA only on "Merge now", or at once with `--auto`. | "Not yet" (the default), `--no-merge`, a merge queue, GitHub auto-merge, a changed head, or a blocked merge |
| 6 | Check each child PR. Land moved it to the base before the merge. GitHub can close it, so give the recovery when it did. | never |
| 7 | Final report. | never |

Read [references/workflow.md](references/workflow.md) for each step's commands and gates.

## Rules

- **GitHub only.** The merge, CI wait, and merge state use `gh`. On GitLab, stop and say so.
- **Never Copilot.** Refuse `-p copilot` before any step. Never request a GitHub Copilot review.
- **Review first.** Without `--auto`, nothing merges until the human answers "Merge now at <sha>" in that turn. "Not yet (I will review)" is the first option and the default.
- **`--auto` comes only from the command line.** Never turn it on from config, an environment variable, or a `/dg:spec` default.
- **Nothing merges later.** Never use gh's own `--auto`, a merge queue, or any setting that merges later by itself. A merge queue or GitHub auto-merge stops the run.
- **Only the main loop merges.** A subagent, a slice wave, or a `/dg:spec --bg` run never runs `gh pr merge`. It stops at step 5 and reports the summary and the merge command.
- **Never work around a blocked merge.** When the harness or a hook blocks `gh pr merge`, print the exact command with a `!` prefix for the human to run, and stop.
- **Merge only the tested head.** Always pass `--match-head-commit <sha>`, where `<sha>` is the head that CI passed on.
- **Move the children first.** GitHub does not move the open PRs of a deleted branch. It can close them. Before `gh pr merge`, set each child's base to the PR's base. When a move fails, do not merge. When the merge fails, set each child back.
- **Do not resolve conflicts here.** A behind or conflicting PR goes to `/dg:catchup`. A stacked PR goes to its parent first, or to `/dg:chain`.
- **No unreviewed CI fix.** Every CI-fix commit gets a review loop before CI runs on it again.
- **Edit nothing directly.** All code changes happen inside `/dg:address`.
