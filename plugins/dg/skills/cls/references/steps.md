# Step 2A: Harness worktree (EnterWorktree session)

The `ExitWorktree` tool restores the session cwd **and** removes the worktree and branch in one shot. Use it instead of the CLI.

1. Close any live browser first (Step 3, browser part). Assets inside the worktree vanish with it, but a running browser process must be stopped on purpose.
2. Call `ExitWorktree` with `action: "remove"`.
   - If it refuses (uncommitted files or unmerged commits), it lists them. **Tell the user and ask** before you call it again with `discard_changes: true`. Never discard silently.
   - If the user wants to keep the work, call `ExitWorktree` with `action: "keep"` and stop (no branch deletion).
3. Sweep the scratch dirs for `BUCKET` and prune this tree's `/dg:bg` job records (Step 3). Both live outside the worktree, so they survive its removal and need their own cleanup.
4. **Land on the default branch** (Step 2D). After the session returns to `$MAIN`, run the shared final stage.
5. **Prune stale branches** (Step 2E). It runs after 2D, while the repo is on `$DEFAULT`.

## Step 2B: Linked or manual worktree

You must leave the directory before you remove it, or later shell calls fail with `getcwd` errors.

1. **Run a defensive `ExitWorktree({action: "keep"})` first.** `/dg:sdlc` and `/dg:spec` enter their worktrees with `EnterWorktree(path=...)`. The path-based `KIND` check cannot see that (their paths are not under `.claude/worktrees/`, so they classify as `linked`). If this session entered with `EnterWorktree`, `keep` moves it out before the directory is deleted. `ExitWorktree` cannot remove a `path`-entered worktree, only restore the cwd out of it. If the session did not enter that way, the call is a documented no-op. Either way, continue.
2. Close any live browser (Step 3, browser part).
3. Run `cd "$MAIN"` to get out of the worktree, so the next Bash call is not stranded. It is harmless if step 1 already moved things. It is still required as the fallback for a plain-`cd` session that never called `EnterWorktree`. It does **not** move the statusline or the user's terminal (see Step 3b for the statusline). Tell the user to `cd "$MAIN"` in their own shell if they were inside the worktree.
4. Remove it:

   ```sh
   ~/.dg/bin/dg-skills worktree remove <slug>
   ```

   Add `--keep-branch` or `--force` only as requested.
   - The three default guards (dirty or untracked files, unpushed commits, branch not merged into `origin/<base>`) **block** unless `--force`. If the CLI stops on a guard, relay its exact message and **ask** before you re-run with `--force`. Never auto-force.
   - Use `--merged-ok` only if the user confirms the PR or MR was merged on the provider (GitHub or GitLab) but `git cherry` cannot see it (a squash merge with no local trace). The CLI's own guard checks this through `~/.dg/bin/dg-skills vcs-provider merged-pr-for-branch`. **Caveat:** `--merged-ok` skips only the merged-into-base guard. When a PR or MR is squash-merged with "delete branch on merge" on, the remote branch is gone. The local branch then reads as no upstream and ahead, and it trips the **unpushed-commits** guard, which `--merged-ok` does not cover. In that case, first check that `~/.dg/bin/dg-skills vcs-provider merged-pr-for-branch <branch>` returns a non-null match. Then `--force` is the correct escalation. The squashed commit is already in `$DEFAULT`, so nothing is lost.
5. Sweep the scratch dirs for `BUCKET` and prune this tree's `/dg:bg` job records (Step 3). Any `--out` directory inside the worktree was deleted with it.
6. **Land on the default branch** (Step 2D). After removal, run the shared final stage. The CLI already deleted the worktree's own branch (`CAME_FROM`), so do NOT try to delete main-repo branches on this path.
7. **Prune stale branches** (Step 2E). It runs after 2D, while the repo is on `$DEFAULT`.

## Step 2C: Main repo, delete the branch you came from

This runs when `KIND=mainrepo`, there is no `<slug>` argument, and `CAME_FROM` is not `DEFAULT`.

1. **Guard, already on default:** if `CAME_FROM` is `DEFAULT`, stop at once. Never delete the default branch.
2. **Guard, clean working tree:** run `git -C "$MAIN" status --porcelain`. If the output is not empty, refuse to switch and ask the user to stash, commit, or pass `--force` on purpose. Never auto-discard a dirty tree.
3. **Switch first:** `git -C "$MAIN" switch "$DEFAULT"`. You cannot delete the branch you are on.
4. **Delete the branch:**

   ```sh
   git -C "$MAIN" branch -d "$CAME_FROM"
   ```

   `git branch -d` refuses if the branch has unmerged commits. If it refuses, relay the exact error and **ask** whether to force-delete with `-D`. Re-run with `git branch -D "$CAME_FROM"` only if the user confirms or `--force` was already passed. Never auto-force.
5. **Fast-forward `$DEFAULT` to origin.** Step 3 landed on `$DEFAULT` with a clean tree (the step 2 guard), so refresh it so it does not lag merged PRs:

   ```sh
   git -C "$MAIN" fetch --prune origin
   git -C "$MAIN" merge --ff-only "origin/$DEFAULT"
   ```

   Use `--ff-only`. If the branches diverged, skip and note it. Never force. Report the outcome: fast-forwarded `<old>..<new>`, already current, or skipped because diverged.
6. **No asset sweep.** The main repo's scratch may belong to ongoing work. Do not sweep it. Skip Steps 3 and 3b on this path (there is no detached worktree path in a focus file to repoint).
7. **Prune stale branches** (Step 2E). The switch landed on `$DEFAULT` in step 3, so the precondition is met. Run 2E now.
8. Report per Step 4.

## Step 2D: Land on the default branch (shared final stage)

This runs at the end of Steps 2A and 2B, after the worktree and its branch are gone and the session is back in `$MAIN`. It does not run after Step 2C (already switched there).

```sh
CURRENT_MAIN_BRANCH=$(git -C "$MAIN" rev-parse --abbrev-ref HEAD)
MAIN_DIRTY=$(git -C "$MAIN" status --porcelain)
```

- If `CURRENT_MAIN_BRANCH` is `DEFAULT`: already there, no switch needed (still fast-forward below).
- If `MAIN_DIRTY` is not empty: skip the switch AND the fast-forward. Note in the Step 4 report that the main repo has uncommitted changes and stays on `$CURRENT_MAIN_BRANCH`. Do not force. Skip Step 2E and note the skip in the report (you cannot safely delete branches from a non-default checkout).
- Otherwise: `git -C "$MAIN" switch "$DEFAULT"` and note the switch in the report.

**Always fast-forward `$DEFAULT` to origin** when `MAIN_DIRTY` is empty (both the already-there and just-switched cases). After a merged PR, the local default otherwise lags origin and serves stale code to later sessions and agents:

```sh
git -C "$MAIN" fetch --prune origin
git -C "$MAIN" merge --ff-only "origin/$DEFAULT"
```

`--ff-only` never creates a merge commit. If the fast-forward fails (local `$DEFAULT` diverged from origin), do NOT force. Leave it and note it in the Step 4 report. Report the outcome either way: fast-forwarded `<old>..<new>`, already current, or skipped (dirty or diverged). Then continue to Step 2E.

Do NOT delete main-repo branches here. The worktree branch was already removed by the CLI or by `ExitWorktree`. Step 2E alone handles branch cleanup.

## Step 2E: Prune stale branches (shared final stage)

**Precondition:** run from `$MAIN`, and only when the main repo is on `$DEFAULT` (Steps 2C and 2D land there). If the repo is not on `$DEFAULT` for any reason, skip the whole sweep and note it in the Step 4 report. Never delete branches from a non-default checkout.

If `--keep-branch` was passed, skip all deletions, report the candidates that would have been removed, and stop.

**Build the candidate set:**

```sh
gone=$(git -C "$MAIN" for-each-ref --format '%(refname:short) %(upstream:track)' refs/heads \
         | awk '$2=="[gone]"{print $1}')
merged=$(git -C "$MAIN" branch --merged "$DEFAULT" --format '%(refname:short)')
wt_branches=$(git -C "$MAIN" worktree list --porcelain \
                | awk '/^branch /{sub(/^refs\/heads\//,"",$2); print $2}')
```

`gone` holds branches whose remote tracking branch is gone (merged-PR leftovers). `merged` holds branches fully merged into the default branch. `wt_branches` holds branches checked out in any worktree (git refuses to delete these anyway).

Candidates are the unique union of `gone` and `merged`, minus `$DEFAULT`, minus `$BRANCH` (the branch you started on, in case you did not switch), minus everything in `wt_branches`.

**Process each candidate:**

```sh
err=$(git -C "$MAIN" branch -d "$b" 2>&1) && { echo "deleted: $b"; continue; }
case "$err" in
  *"not fully merged"*) echo "RISKY (local-only commits): $b" ;;
  *"used by worktree"*|*"checked out"*) echo "protected (worktree): $b" ;;
  *) echo "skipped: $b -- $err" ;;
esac
```

Collect the RISKY branches and ask before any `-D`. Skip the protected ones and never `-D` them. After the loop, if any RISKY branches were collected, show each one's tip sha and local-only commit count:

```sh
git -C "$MAIN" rev-list --count "$DEFAULT".."$b"
```

Then ask the user whether to `git branch -D` them one by one. Force-delete only the ones the user confirms. If `--force` was passed, pre-authorization is granted: force-delete all RISKY candidates, but list every branch you are about to force-delete first. Mention recovery: a force-deleted branch's tip stays in the reflog (`git branch <name> <sha>`).

## Step 3: Sweep leftover assets

Skip this whole step if `--keep-assets` was passed.

**Browser (optional).** The browser close needs `~/.dg/bin/dg-skills pw`. It ships with a later release, so skip the close with a note when the probe fails. Do not guess a close verb: when the probe passes, read `~/.dg/bin/dg-skills pw --help` and use the close command it lists. A scratch session is bound to the directory it opened in, so run the close from the worktree before it is removed.

```sh
if ~/.dg/bin/dg-skills pw --help >/dev/null 2>&1; then
  echo "pw is installed: close the session with the verb listed by ~/.dg/bin/dg-skills pw --help"
else
  echo "pw is not installed: browser close skipped"
fi
```

**Scratch dirs** keyed to the worktree's cwd bucket. `pw` and other scratch-using tools store under `<scratch root>/<tool>/<bucket>/`. This block works alone: it sets `TOP` from the detect.md value, computes the bucket again, and stops when either is empty.

```sh
: "${TOP:?TOP is empty: set it to the worktree path from detect.md}"
BUCKET=$(basename "$(~/.dg/bin/dg-skills stash -C "$TOP" pw)")
: "${BUCKET:?BUCKET is empty}"
SCRATCH=$(~/.dg/bin/dg-skills stash -r)
if [ -n "$SCRATCH" ] && [ -n "$BUCKET" ] && [ "$BUCKET" != "." ] && [ "$BUCKET" != "/" ]; then
  rm -rf "$SCRATCH/pw/$BUCKET"
fi
```

**State root, per-tree records only.** Do NOT sweep the state root (`~/.dg/bin/dg-skills stash -r -s`) by `$BUCKET`. It is keyed by the *main worktree*, so one bucket covers every worktree of the repo. Deleting by bucket would destroy the main repo's and every sibling worktree's `spec`, `sdlc`, `monolith` and `jot` state. `/dg:address` reaps those at merge, and the daily prune catches the rest at 30 days.

The one exception is `/dg:bg`. Its job records are global-scope and carry their own `cwd` field, so they are per-tree, and once this worktree is gone nothing will read them:

```sh
~/.dg/bin/dg-skills bg prune --cwd "$TOP"
```

`$TOP` is the worktree path from detect.md. It is already deleted by this point, which is fine: prune matches the `cwd` string each job recorded and never touches the filesystem there. It does need a *valid* cwd to run in, so it must come after Step 2A's or 2B's `cd "$MAIN"`. Invoked from inside the deleted worktree, it exits silently with no output. It removes the records of every job that is not running from both roots and reports any job still **running** in that tree without touching it. Their records are the only handle left to cancel them. If `running` is not empty, name those jobs to the user and let them decide: `~/.dg/bin/dg-skills bg cancel <id>` and then `~/.dg/bin/dg-skills bg prune --cwd "$TOP"` again, or leave them. Do not kill a live job on the user's behalf here. Prune never matches a sibling path: pruning `/repo` leaves jobs in `/repo-other` alone.

Caveat: the bucket is keyed to the *cwd where the tool ran*. This catches assets created from the worktree root (the common case). If `pw open --out=<dir>` pointed into the worktree, those files went with the worktree. Do not hunt beyond this. Stale scratch dirs are wiped at reboot and pruned after 14 days. Report what you swept and move on.

## Step 3b: Repoint the statusline (focus file)

This runs even under `--keep-assets` (it is statusline state, not scratch). It does not run on the Step 2C path (no worktree was removed). The statusline reads a directory path from `~/.claude/.cc-focus-<sid>` and then `~/.claude/.cc-focus`. If one points at the worktree you just removed, the statusline would show a deleted dir. Rewrite it to `$MAIN` so it snaps to the main repo and its branch:

```sh
for ff in "$HOME/.claude/.cc-focus" "$HOME"/.claude/.cc-focus-*; do
  [ -f "$ff" ] || continue
  cur=$(cat "$ff" 2>/dev/null)
  [ "${cur%/}" = "${TOP%/}" ] && printf '%s\n' "$MAIN" > "$ff"
done
```

Leave focus files that point anywhere else untouched. If no focus file exists, the statusline tracks the raw session cwd and there is nothing to do. The harness path's `ExitWorktree` already repointed it. The linked path cannot, so report where things stand.

## Step 4: Report

Give one short summary that shows **folder and branch**, so it lines up with the statusline:

- the branch removed (or kept, or refused with the reason) and the worktree path that is now gone;
- where the session and statusline now point (`$MAIN`) and which branch the main repo is on (it should be `DEFAULT` unless the tree was dirty);
- the fast-forward result for local `$DEFAULT`: fast-forwarded `<old>..<new>`, already current, or skipped (dirty or diverged);
- which scratch dirs were swept, whether the browser close ran or was skipped, and whether a focus file was repointed;
- on the Step 2C path: whether the branch was deleted, kept (why), or refused (relay the exact git error);
- the **stale-branch sweep (Step 2E):** which branches were safely deleted, which were skipped or protected (checked out in a worktree), which risky branches await confirmation or were force-deleted, and which candidates were only reported because of `--keep-branch`. If the sweep was skipped because the repo was not on `$DEFAULT`, say so plainly.

If a guard blocked removal and the user declined `--force`, say so plainly: nothing was removed.

## Notes

- **Three different cwds.** (1) The *session* cwd drives the statusline. Only `ExitWorktree` or a focus-file rewrite (Step 3b) changes it. (2) The *Bash-tool* cwd: `cd "$MAIN"` moves only this, just enough to keep later calls off a deleted path. (3) The *user's terminal* cwd: the skill cannot touch it. If they were inside the removed worktree, tell them to `cd "$MAIN"`.
- `/dg:cls` removes worktrees and branches, their scratch, and their own finished `/dg:bg` job records. It does **not** touch scratch dirs for other worktrees, the shared project-keyed state root, the main repo's `.agents/`, or any committed files. For stale worktree records (paths already gone) use `~/.dg/bin/dg-skills worktree prune`.
- **`git branch -d` versus `-D`.** `/dg:cls` always tries `-d` first. It is the safe default that refuses unmerged work. The `-D` escalation needs explicit user confirmation or `--force`. This mirrors the worktree CLI's own guard philosophy.
- **Stale-branch classes (Step 2E).** *Upstream-gone*: the tracking remote branch no longer exists (found through `%(upstream:track)` equal to `[gone]`). This is typical for branches whose PR was merged or closed on the remote. *Merged-into-default*: the branch's commits are reachable from `$DEFAULT` (found with `git branch --merged`). Both are safe to `-d`. The one exception is a branch with local-only commits that were not pushed. `-d` refuses those, and they are the RISKY set.
- **Reflog recovery.** A branch deleted with `-D` is not gone for good. The tip commit stays in the reflog: run `git reflog | grep <sha>`, then `git branch <name> <sha>` to recreate it. The window before GC is at least 30 days by default.
