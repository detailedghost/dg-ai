# Stat list upkeep, overwatch and piping

This mirrors the owner's personal stat skill: **`/dg:stat` itself never calls `stat add`, `stat done`, or `stat status`** — those are for the main loop's normal work, run as it lands, so the checklist stays current without anyone hand-editing the file.

```sh
dg stat add "Phone feature to PR" --status running --eta "~1 hr"
dg stat add "Fix the flaky listener test" --status running --under 1
dg stat add "Approve the Wave 6/7 PR batch" --status blocked-user
dg stat done "Phone feature"
dg stat status "Phone feature" queued --eta "~30 min"
```

- `--eta` accepts only `<5 min`, `~15 min`, `~30 min`, `~1 hr`, `>1 hr` and `unknown`. Any other value fails with a non-zero exit and an error that lists these buckets. Use `>1 hr` for work longer than an hour.
- When you start a task or hand the user a step, `stat add` it with the status that fits (`running`, `queued`, `blocked-user`, `needs-user`); add `--eta <bucket>` when you can estimate.
- When you finish one, `stat done "<match>"`. It matches parents and sub-items by a case-insensitive substring; 0 or 2+ matches is an error listing every candidate, so make the match specific.
- `--at <n>` places a new top-level item at the shown number `n` (default: the end of the plan). A number inside the done range means the first open slot,
  and one past the end appends. It fails with a non-zero exit, writing nothing, when a `needs-user` or `parked` item cannot land there, because those sit
  after the plan. `--under <n|match>` adds it as a sub-item of that open top-level item instead.
- When the done section is long, run `dg stat archive`. It moves every done item, with its sub-items, into `checklist-archive.md` beside the checklist. Add `--dry-run` to preview and `--json` for the report. The report counts open sub-items that went with a done parent; reopen them with `stat add` if they still matter.
- There is no separate `reopen` command: `stat status "<match>" queued` (or any open status) moves a done item back to the end of the open list.

## `--overwatch`

A second exception to read-only: it publishes this session's work to the live overwatch board on the daemon's /board page.

1. Load the `/dg:overwatch` skill and follow it. It owns the session start, the lane publish commands and the board open step. Publish one lane per checklist item and per session-only row, with its task, stage, MR, ETA and next step.
2. Open or focus the board tab as `/dg:overwatch` describes.
3. Republish the phone snapshot as `/dg:overwatch` describes (throttled, same artifact url).

If the overwatch agent binary is missing or the daemon is down, say so in one line and fall back to the plain checklist.

## Piping `--long`

Its output is POSIX: tab-separated fields, one header line, ASCII only, no embedded tabs or newlines, and a final `#`-prefixed total line a pipeline can skip.

The section 4 cleanup summary and the section 5 reap and stop lines are `#`-prefixed lines on `--long` too, so the same filter skips them.

Rows already print in plan order — a sub-item's row follows its parent's directly, so no sort step is needed.

The WORK column:

```sh
dg stat checklist -l | awk -F '\t' '!/^#/ && NR>1 {print $4}'
```

The STATUS column, header included:

```sh
dg stat checklist -l | cut -f3
```
