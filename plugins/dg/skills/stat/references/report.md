# Stat report, edge cases and cleanup rules

## 2. Report

Print the checklist view the caller asked for, as the CLI renders it. With no flag this is `dg stat checklist`; `--plain` adds `-p`; `--long` adds `-l`.

The CLI already handles ordering, numbering, sub-items, the done cap, and a Total line computed from the checklist's own unfinished agent items — sub-items included, even under a done parent, and parked work excluded. Two things are still judgment, left to the main loop:

- **Items waiting on the user.** When the CLI prints a `Waiting on you: N items.` line, keep it. Then offer to hand those items to `/dg:walk stat`. Ask once. Do not start the walk without a yes.
- **Session-only work not yet on the list.** Prefer adding it first (see "Keeping the list current" in SKILL.md), so the checklist already reflects it. If you do not, append a short, plain trailer after the CLI's own output: `Also running, not on the list:` followed by one line per item. Do this for the default and `--plain` views; for `--long`, append the same items as additional rows (see views.md) instead.
- **A fuller critical-path total.** The CLI's `Total:`/`# Total:` line is computed from checklist agent ETAs alone. When this session also has foreground or background work not on the checklist, recompute the total as `max(foreground serial chain, longest background chain)` — the critical path, not the sum — folding in the checklist's own total as one candidate chain. Replace the CLI's total line with this fuller one; name the chain that set the number.

For session-only work on `--long`, append rows in the CLI's 7 tab-separated fields and recompute the `#` total. Row rules: [references/views.md](views.md).

## 3. Edge cases

| Case | Behavior |
|---|---|
| Nothing in flight | `stat checklist` already prints one line naming how to add an item; relay it as-is |
| Branch has no PR yet | PR/MR cell `—` (or `-` on `--long`), not an error |
| No git repo, or provider unauthenticated | Skip the PR lookup, cell `—`/`-`, still report the rest. Never hard-fail |
| Job finished (`done`, failed, timed out, `canceled`) | List it once (as a session-only row) with its terminal state so the user learns it landed, then clean it up (section 4); contributes nothing to the total |
| Job `unknown` | `STATUS` `unknown`, `DETAIL`/`Also running` line carries its `logFile` |
| Parked worktree | `STATUS` `parked`, no ETA, excluded from the total |


## Cleanup rules

- Clean only rows that show a terminal state. Treat an `unknown` job as unfinished: leave it, and skip `dg bg prune` while this tree has one, because prune would delete the log the user needs to read. Prune also removes the session record that `dg bg update` needs to resume a finished job, so skip it when the user may resume one.
- Subagents cannot call `TaskStop`. Only the main loop does. A subagent reports the finished tasks and stops there.
- The total ignores cleaned jobs.
- Report what was cleaned in one line under the checklist. Default and `--plain` print
  `Cleaned: 3 finished jobs (2 bg records, 1 task stopped). Left running: 1.` On `--long`,
  prefix that sentence with `# ` so `awk -F '\t' '!/^#/'` skips it with the total:
  `# Cleaned: 3 finished jobs (2 bg records, 1 task stopped). Left running: 1.`
  Print nothing when nothing finished.


