# Stacked runs

`--stacked` runs the same steps across the stack, keeping per-PR output out of context. Each launch
prompt gets the `REPO` of its own PR: the `repo.root` of that PR's row. Each shell loop runs only
`dg thrash` commands. Skip steps 3 to 6 for a PR whose row has no `repo` or whose
`repo.source` is `none`, and for the whole stack with `--no-repo` or `--proxy`.

1. `dg thrash stack "$TARGET" --diff` (Bash timeout 600000 ms) walks every PR in the stack, open, merged or closed,
   root first, and prints one row per PR with `number`, `url`, `state` and `reviewed`.
   Only **open** PRs are reviewed: their rows add `diffPath`, `contextPath`, `chunks`,
   `skipped`, `changed` and `repo`, and each context file lists the merged PRs as context.
   A **merged** PR is never reviewed again; its row has a `statusPath` and tally shows
   "merged (context only, not reviewed)". A **closed** unmerged PR gets the same and shows
   "closed without merging (not reviewed)". Report closed PRs to the user.
2. Launch the reviewers of every PR in waves of 16 or fewer, or every `--proxy` job. Wait for
   all `WROTE` replies.
3. Run `triage --stage merge` for each PR in one shell loop, with stdout sent to a file for each PR.
   Read `tasks[]` from those files.
4. One verify pass for all PRs: launch one `dg:thrash-verify` agent for each task, in waves of 16 or
   fewer.
5. Run `triage --stage apply` for each PR in one shell loop.
6. Launch one `dg:thrash-consolidate` agent for each PR with more than one `chunks[]` entry, also in
   waves.
7. Compile every PR in one shell loop with stdout sent to `/dev/null`; errors still show.
   Each review JSON is its `diffPath` with `.diff` replaced by `.review.json`.
8. `dg thrash tally` on all review files plus every `statusPath`, in stack order, is the
   preview; unposted rows say so.
   For `--dry-run`, run the `post --dry-run` loop so each scratch tree is removed, show the unposted
   tally and stop. Otherwise one confirm covers the stack when any review approves or requests changes, or when `--confirm` was passed. Pass `--confirm` to each such post.
9. Post in one shell loop with stdout sent to `/dev/null` (with `--dry-run` in report-only
   mode), then run `tally` again on the same files as the final report.
