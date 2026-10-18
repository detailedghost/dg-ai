---
name: pushup
description: Push the current branch, open its PR, and drop that PR into a dg:browser tab group in one step. Use when committed work is ready to share — "push this up", "ship it", "open a PR and show me". Re-running on a branch that already has a PR just reopens it in the browser.
allowed-tools: Bash(git:*) Bash(gh:*) Bash(~/.dg/bin/dg-skills:*) Bash(cat:*) Bash(printf:*)
---

# /pushup — push, PR, open it

Carries committed work from a feature branch to a PR sitting open in the browser. Assumes the
commits already have the shape you want them reviewed in.

## Usage

```
/pushup                 # push, open a PR, open it in the "pr" tab group
/pushup --draft         # open the PR as a draft
/pushup --group <name>  # use a different dg:browser tab group
```

## Steps

1. **Guard the branch.** `git branch --show-current`. On the default branch, stop and say so —
   choosing a branch name is the user's call, not yours.
2. **Check the tree.** `git status --short`. With uncommitted changes, ask whether to commit or
   leave them. Never commit silently.
3. **Push.** `git push -u origin <branch>`.
4. **Reuse an existing PR.** `gh pr view --json url -q .url`. If one comes back, skip to step 6.
   Never open a second PR for the same branch.
5. **Open the PR.** Title: one conventional-commit line covering the change as a whole. Body: two
   sentences of context, then one tight bullet per logical change.
6. **Open it in the browser.** `"$DG" batch-open --group <name> <url>`, defaulting to group
   `pr`. Bootstrap the binary first when missing:

   ```sh
   DG="${DG_HOME:-$HOME/.dg}/bin/dg-skills"
   if [ ! -x "$DG" ]; then
     PLUGIN_ROOT="${DG_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}"
     LOCAL_BOOTSTRAP="${PLUGIN_ROOT}/pkg/skills-cli/bootstrap.sh"
     if [ -n "$PLUGIN_ROOT" ] && [ -f "$LOCAL_BOOTSTRAP" ]; then
       sh "$LOCAL_BOOTSTRAP"
     else
       curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/master/pkg/skills-cli/bootstrap.sh | sh
     fi
   fi
   ```

   Report which group you used.

## PR body rules

A hook on `gh pr create` rejects bodies that fail to read as plain English. It flags wordiness and
passive voice, so write short active sentences. Prefer "one component covers both cases" over the
passive rewrite of the same claim. Say what changed and why.

## Delegation

- Commits in the wrong shape → `/meaningful` first, then come back.
- 2+ dependent PRs → `/chain`, and the batch-PR approval gate applies before opening any of them.
- Review comments or failing checks afterwards → `/address`.
