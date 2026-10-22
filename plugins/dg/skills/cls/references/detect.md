# Step 1: Detect context

Run from the current directory. It captures whether you are in a worktree and which flavor, plus two values needed for the final landing:

```sh
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then echo "KIND=notgit"; exit 0; fi
MAIN=$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')
TOP=$(git rev-parse --show-toplevel)
BRANCH=$(git rev-parse --abbrev-ref HEAD)
SLUG="${BRANCH##*/}"
BUCKET=$(basename "$(~/.dg/bin/dg-skills stash -C "$TOP" pw)")
DEFAULT=$(git -C "$MAIN" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')
if [ -z "$DEFAULT" ]; then
  git -C "$MAIN" show-ref --verify --quiet refs/heads/main 2>/dev/null && DEFAULT=main || DEFAULT=master
fi
CAME_FROM="$BRANCH"
case "$TOP" in
  */.claude/worktrees/*) KIND=harness ;;
  *) [ "$TOP" = "$MAIN" ] && KIND=mainrepo || KIND=linked ;;
esac
printf 'KIND=%s\nMAIN=%s\nTOP=%s\nBRANCH=%s\nSLUG=%s\nBUCKET=%s\nDEFAULT=%s\nCAME_FROM=%s\n' \
  "$KIND" "$MAIN" "$TOP" "$BRANCH" "$SLUG" "$BUCKET" "$DEFAULT" "$CAME_FROM"
```

`DEFAULT` comes from `origin/HEAD`, with `main` and then `master` as fallbacks. `CAME_FROM` is always the branch you started on, captured before any teardown.

- **`harness`**: created by the `EnterWorktree` tool (it lives under `<repo>/.claude/worktrees/`). The session is inside it. Go to Step 2A.
- **`linked`**: a worktree made by `~/.dg/bin/dg-skills worktree create` or by hand that the session is sitting in. Go to Step 2B (target is the current `SLUG`).
- **`mainrepo`**: already in the main repo. If a `<slug>` argument was given, go to Step 2B for that slug. If `CAME_FROM` is not `DEFAULT` (a non-default branch and no slug), go to Step 2C (switch and delete the branch). If already on `DEFAULT` with no slug, **list the linked worktrees** before concluding there is nothing to do: run `git worktree list --porcelain` and drop the `$MAIN` entry. Running `/dg:cls` from the main repo right after finishing worktree work is the common case, so a lone linked worktree is the implied target:
    - **Exactly one** linked worktree: target its slug through Step 2B. The CLI's own guards (dirty, unpushed, unmerged) still protect it. If one fires, relay it and ask before `--force`. Never auto-force.
    - **More than one:** list them and ask which to close, or ask for a re-run with a `<slug>`. Do NOT pick one at random and do NOT sweep assets until one is chosen.
    - **None:** there is no worktree to close. Do NOT sweep assets, because the main repo's scratch may belong to active work on the current branch. Report that, then continue to Step 2E (the stale-branch sweep always runs).
- **`notgit`**: not a git repo. Only the asset sweep applies.

If a `<slug>` argument is passed while inside a worktree, prefer it over the detected `SLUG`.
