# Staleness Check

A parked bundle can go stale if the files its slices reference (`slices[].files` globs in
`plan.md`) changed after the bundle was written. `/dg:pickup` checks this itself — `/dg:spec -s` has no
partial re-entry into a single plan-mode step, so there is no phase to hand this off to.

## Check

For the selected bundle's `plan.md`, run this in the origin repo (before any worktree exists — this
must happen before step 3's renumber/handoff, and `/dg:spec -s`'s worktree branches off a fresh
`origin/<base>` that won't reflect uncommitted changes anyway):

1. Read `date` (frontmatter) and every slice's `files[]` globs.
1. `git log --since="<date>" --oneline -- <files...>`. Non-empty output = stale.
1. If stale: `AskUserQuestion` — "Files touched by this bundle's slices changed since it was parked
   on `<date>`. Proceed anyway, or abort so it can be re-planned?" Options: *Proceed* (continue to
   renumber/handoff as normal), *Abort* (stop; suggest re-running `/dg:spec "<request>"` fresh, or
   hand-editing `plan.md` directly for a small drift).
1. If not stale — or the repo has no matching history (e.g. files not yet committed anywhere) —
   proceed without asking.

`/dg:pickup` does not attempt to re-run plan-mode's review/synthesis steps (5–6) in isolation — that
pipeline is not individually resumable outside a full plan-mode invocation.
