---
name: pushup
description: Push the current branch, open its PR, and drop that PR into a dg:browser tab group in one step. Use when committed work is ready to share — "push this up", "ship it", "open a PR and show me". Re-running on a branch that already has a PR just reopens it in the browser.
allowed-tools: Bash(git branch:*) Bash(git status:*) Bash(git push:*) Bash(gh pr:*) Bash(~/.dg/bin/dg-skills:*)
---

# /dg:pushup — push, PR, open it

Carries committed work from a feature branch to a PR sitting open in the browser. Assumes the
commits already have the shape you want them reviewed in.

If a step fails, run ~/.dg/bin/dg-skills doctor batch-open.

## Usage

**Usage:** `/dg:pushup [--draft] [--group <name>]`

```
/dg:pushup                 # push, open a PR, open it in the "pr" tab group
/dg:pushup --draft         # open the PR as a draft
/dg:pushup --group <name>  # use a different dg:browser tab group
```

## Flags

| Flag | Short | Effect | Default |
|---|---|---|---|
| `--draft` | none | Open the PR as a draft. | off |
| `--group <name>` | none | Use a different dg:browser tab group. | `pr` |

## Steps

1. **Guard the branch.** `git branch --show-current`. On the default branch, stop and say so —
   choosing a branch name is the user's call, not yours.
2. **Check the tree.** `git status --short`. With uncommitted changes, ask whether to commit or
   leave them. Never commit silently.
3. **Push.** `git push -u origin <branch>`.
4. **Reuse an existing PR.** `gh pr view --json url -q .url`. If one comes back, skip to step 6.
   Never open a second PR for the same branch.
5. **Open the PR.** With `--draft`, pass `--draft` to `gh pr create`. Title: one conventional-commit line covering the change as a whole. Body: two
   sentences of context, then one tight bullet per logical change.
6. **Open it in the browser.** `~/.dg/bin/dg-skills batch-open --group <name> <url>`, defaulting to group
   `pr`. Bootstrap the binary first when missing. The bootstrap runs `sh` and `curl`, which this skill
   does not pre-approve, so Claude Code asks before each one:

   ```sh
   ~/.dg/bin/dg-skills batch-open --help >/dev/null 2>&1 ||
     curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.18.1/pkg/skills-cli/bootstrap.sh | sh
   ```

   Report which group you used. If `batch-open` fails, print the PR URL and continue: the PR already exists.

## PR body rules

A hook on `gh pr create` rejects bodies that fail to read as plain English. It flags wordiness and
passive voice, so write short active sentences. Prefer "one component covers both cases" over the
passive rewrite of the same claim. Say what changed and why.

## Delegation

- Commits in the wrong shape → `/dg:meaningful` first, then come back.
- 2+ dependent PRs → `/dg:chain`, and the batch-PR approval gate applies before opening any of them.
- Review comments or failing checks afterwards → `/dg:address`.
