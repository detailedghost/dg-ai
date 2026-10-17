# Staleness Check

A parked bundle can go stale if the files its slices reference (`files` globs in
`plan.md`) changed after the bundle was written. `/pickup` checks this itself before it implements.

## Check

For the selected bundle's `plan.md`, run this in the current checkout before step 3's renumber:

1. Read `date` (frontmatter) and every slice's `files[]` globs.
2. `git log --since="<date>" --oneline -- <files...>`. Non-empty output = stale.
3. If stale: `AskUserQuestion` — "Files touched by this bundle's slices changed since it was parked
   on `<date>`. Proceed anyway, or abort so it can be re-planned?" Options: *Proceed* (continue to
   renumber and implement as normal), *Abort* (stop; suggest re-running `/kick` fresh, or
   hand-editing `plan.md` directly for a small drift).
4. If not stale — or the repo has no matching history (e.g. files not yet committed anywhere) —
   proceed without asking.

`/pickup` does not re-run the interview. A stale plan is either accepted by the user or rewritten with `/kick`.
