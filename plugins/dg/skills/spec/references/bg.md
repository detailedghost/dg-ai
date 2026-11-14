# Background execute — the `--bg` unattended contract

Read this file only when `--bg` is present. It lists deltas on a normal `-s` run. It replaces
[engineering.md 4.3](../../sdlc/references/engineering.md) step 1 and [finish.md](../../sdlc/references/finish.md)
5.c, and copies neither. `--bg` is valid only with `-s`; bare plan mode with `--bg` stops and says so.
The run stays in this session. Use `/dg:bg` to detach it.

## Before launch

Launch is the first `assign resolve` call. Before it, run these in order:

1. The execute.md §1 open-row check. It stops first and has no side effects.
2. The `-s --profile` sequence in [profiles.md](profiles.md), when a profile flag is given.
   It can ask through the `/dg:assign` backfill.
3. The permissions check. All six keys (`run_commands`, `git_push`, `gh_pr_create`,
   `auto_cleanup_worktree`, `slice_commits`, `housekeeping_commit`) must be granted before launch.
   When any is missing, ask once for `dg-skills spec perms-batch <bundle>/plan.md --grant-all`,
   or stop.
4. The `-s --proxy` per-slice prompt in [proxy.md](proxy.md), when `--proxy` is given. Slices with
   `agents.proxy` run unprompted.

After launch, no `AskUserQuestion` is called. Every question becomes a recorded row.

## Recording a row

Record each `SPEC`, `TEST` or `CRITICAL` deferral:

```sh
dg-skills spec issues add "$SPEC_PATH" --slice <N> --from deferral --severity high --desc '<TYPE>: <text>'
```

Record an `unverified` result, a dropped slice, and a `blocked` result with no deferral the same
way, with `--desc 'UNVERIFIED: <summary>'`. A `CONFIRM` deferral is never recorded.

Replace `|` with `/` in the `--desc` text, with newlines collapsed to one space. Wrap the text in
single quotes and escape each `'` as `'\''`.

## Commit and pause

A slice with a recorded row, and every transitive dependent of it from `depends_on`, is skipped at commit.
Independent slices finish and commit as usual.

When any row was recorded, skip finish.md 5-8 and print last, literally:

`Run paused with <n> open question(s) in ## Issues Remediation. Resume with /dg:spec -s <NNN>_<slug>`

`<n>` counts the open `from: deferral` rows after the run. The resume line carries no flags,
because `execution.profile` and `agents.proxy` persist. The worktree is never removed on pause,
and the worktree is reused on resume.

When no row was recorded, continue into finish.md 5-8 as a normal run.

## No land under `--bg`

A `--bg` run skips [execute.md](execute.md) §7, as if `--no-land` were given. The `/dg:land` merge
gate asks a question, and this run asks none. The PR stays a draft. Print last:
`Land it later with /dg:land <url>.`

## Final review, finish.md 5.c

Under `--bg`, a CRITICAL or HIGH-security residual after the last round is recorded as a
`--from deferral` row. The run then pauses before step 8 with the same resume line. Every other
residual goes to `## Issues Remediation` with no ack, and the draft PR opens with them under
`## Known Issues (Deferred)`.
