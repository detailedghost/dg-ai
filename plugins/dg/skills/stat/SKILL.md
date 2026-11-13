---
name: stat
description: Report this session's in-flight work as a priority-ordered checklist, split by status (what the agent is doing, what's queued, what's waiting on the user), plus a critical-path total. Read-only glance, except it removes finished background jobs, reaps leftover agent processes, and stops stuck loops. Triggers on "/dg:stat", "what's in flight", "where are we at", "status of everything", "show the checklist".
---

# /dg:stat: What's In Flight

A four-keystroke glance at this session's work, rendered as one numbered checklist. **Read-only, with three exceptions:** it cleans up background jobs that have FINISHED (section 4), it reaps leftover agent processes (section 5), and it stops work that is clearly stuck: wait loops, stalled bg jobs, silent background Agents, and cron jobs with no effect (section 5). Never edit, commit, push, or resume anything, and **never stop a running job that makes progress**. If reading cannot answer something, report the gap instead of acting.

First run: install or refresh the CLI when it is missing or too old. Each Bash call works alone:

```bash
dg-skills stat --help >/dev/null 2>&1 ||
  "${DG_HOME:-$HOME/.local}/bin/dg-skills" stat --help >/dev/null 2>&1 ||
  curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh -s -- --cli-only
```

Call `dg-skills` in every later step. If `dg-skills` alone does not answer, also after the bootstrap, call `${DG_HOME:-$HOME/.local}/bin/dg-skills` instead.

If a step fails, run dg-skills doctor bg stat vcs-provider worktree.

## Usage

**Usage:** `/dg:stat [-l|--long] [-p|--plain] [--overwatch]`

## Flags

| Flag | Short | Effect | Default |
|---|---|---|---|
| `--long` | `-l` | Print a POSIX tab-separated table instead of the checklist | off (checklist) |
| `--plain` | `-p` | Print an ASCII, GitHub-flavored-markdown checklist instead (pastes cleanly, greps cleanly) | off (emoji checklist) |
| `--overwatch` | none | Publish the lanes to the live overwatch board (see below) | off (terminal checklist) |

Finished-job cleanup (section 4) and the reap and stuck-loop step (section 5) have no flag. They run on every `/dg:stat`.

## Statuses

One status per item drives its emoji (default view), its word (`--plain` and `--long`), and who owns it. The emoji replaces a checkbox; `--plain` keeps `[ ]`/`[x]` instead, with `[x]` reserved for `done`:

| Status | Emoji | Owner | Meaning |
|---|---|---|---|
| `queued` | ⏳ | agent | Waits on another item or a time |
| `running` | 🔄 | agent | An agent is working on it now |
| `blocked-user` | 🛑 | user | Agent work cannot continue until the user acts |
| `needs-user` | 👀 | user | The user should do it, but nothing is waiting on it |
| `parked` | ⏸️ | agent | Paused, not currently being worked |
| `failed` | ❌ | agent | Attempted and failed |
| `done` | ✅ | — | Finished; a done item's earlier owner is not retained |

Example (`/dg:stat`, default view):

```
1. ✅ Sign in to GitHub
2. 🔄 Phone feature to PR [~1 hr]  ← you are here
   1. 🔄 Fix the flaky listener test
3. 🛑 Approve the Wave 6/7 PR batch
4. ⏳ Slice 6 [~15 min]

Off the critical path:
5. 👀 Sign the vendor form

Total: ~1 hr (critical path: 2 Phone feature to PR)
Waiting on you: 2 items. Run /dg:walk stat to walk them.
```

The same checklist, `--plain`:

```text
1. [x] done: Sign in to GitHub
2. [ ] running: Phone feature to PR [~1 hr]  <- you are here
   1. [ ] running: Fix the flaky listener test
3. [ ] blocked-user: Approve the Wave 6/7 PR batch
4. [ ] queued: Slice 6 [~15 min]

Off the critical path:
5. [ ] needs-user: Sign the vendor form

# Total: ~1 hr (critical path: 2 Phone feature to PR)
Waiting on you: 2 items. Run /dg:walk stat to walk them.
```

The same checklist, `--long` (tab-separated):

```text
ORDER	OWNER	STATUS	WORK	DETAIL	PR/MR	ETA
1	-	done	Sign in to GitHub	-	-	-
2	agent	running	Phone feature to PR	-	-	~1 hr
-	agent	running	Fix the flaky listener test	-	-	-
3	user	blocked-user	Approve the Wave 6/7 PR batch	-	-	-
4	agent	queued	Slice 6	-	-	~15 min
5	user	needs-user	Sign the vendor form	-	-	-
# Total: ~1 hr (critical path: 2 Phone feature to PR)
# Waiting on you: 2 items. Run /dg:walk stat to walk them.
```

The list reads in plan order, so it shows where the plan stands. Done items come first, oldest first, and take the first numbers. Older done items past the cap are hidden behind an `...and N earlier done` line at the top, and keep their numbers, so ticking the current step changes no other number. Open items follow in stored order, which is the plan order: add them in the order the work runs, and use `--at` to place one. `blocked-user` items stay in place, because they hold up the plan. `needs-user` and `parked` items move after the plan, under an `Off the critical path:` line. The default and `--plain` views mark the first open plan step with `← you are here` (`<- you are here` in `--plain`). `--long` prints neither line, so its rows stay a plain table. `--at` and `--under` take the number shown. A sub-item nests one level under its parent and restarts its own number at 1 in the default and `--plain` views. On `--long`, a sub-item row carries `-` in `ORDER` instead and prints directly under its parent, in stored order — rows already print in plan order, so there is nothing to sort. When a sub-item is the critical path, that total reads `(critical path: <text>, under <parent number>)`, using the parent number visible in ORDER. A sub-item can be ticked on its own; ticking a parent does not tick its sub-items, and finishing every sub-item does not tick the parent — mark each explicitly. User items (`blocked-user`/`needs-user`) never show an ETA, because the wait is on the user, not the agent.

## 1. Gather: one Bash call, filtered in the shell

Every filter runs in the shell, so only the small result enters context. Never echo this raw output back to the user. Each CLI call fails soft: a missing CLI, no repo, or an unauthenticated provider gives `[]`, never an error.

```sh
b=$(git branch --show-current 2>/dev/null)
echo "BRANCH=${b:-none}"
prs=
if [ -n "$b" ]; then
  prs=$(dg-skills vcs-provider list-prs --head "$b" 2>/dev/null | jq -c '[.[]|{number,state,title}]' 2>/dev/null)
fi
echo "PRS=${prs:-[]}"
jobs=$(dg-skills bg list 2>/dev/null | jq -c --arg d "$PWD" '[.jobs[]|select(.cwd==$d or ((.cwd // "")|startswith($d+"/")))|{id,state,exitCode,logFile,cmd:.command[0:60]}]' 2>/dev/null)
echo "JOBS=${jobs:-[]}"
echo "WORKTREES=$(dg-skills worktree list --porcelain 2>/dev/null | tr '\n' ' ')"
checklist=$(dg-skills stat checklist --json 2>/dev/null)
echo "CHECKLIST=${checklist:-null}"
```

`dg-skills bg list` is machine-wide with no `--cwd` filter. The jq `select` keeps it from dumping every job ever launched. It matches the directory or a path inside it, never a sibling like `/repo-other`. PR lookup goes through `dg-skills vcs-provider`, never `gh` or `glab` directly. The checklist is per repo (shared by linked worktrees) or per cwd outside a repo; `dg-skills stat checklist` already orders, numbers, and totals it, so this gather step only needs its JSON for merging.

Then add what only you know: your current foreground task, how far into it you are, and any subagent or background work this session launched that is not yet on the checklist.

## 2. Report

Print the checklist view the caller asked for, as the CLI renders it. With no flag this is `dg-skills stat checklist`; `--plain` adds `-p`; `--long` adds `-l`.

The CLI already handles ordering, numbering, sub-items, the done cap, and a Total line computed from the checklist's own unfinished agent items — sub-items included, even under a done parent, and parked work excluded. Two things are still judgment, left to the main loop:

- **Items waiting on the user.** When the CLI prints a `Waiting on you: N items.` line, keep it. Then offer to hand those items to `/dg:walk stat`. Ask once. Do not start the walk without a yes.
- **Session-only work not yet on the list.** Prefer adding it first (see "Keeping the list current" below), so the checklist already reflects it. If you do not, append a short, plain trailer after the CLI's own output: `Also running, not on the list:` followed by one line per item. Do this for the default and `--plain` views; for `--long`, append the same items as additional rows (see below) instead.
- **A fuller critical-path total.** The CLI's `Total:`/`# Total:` line is computed from checklist agent ETAs alone. When this session also has foreground or background work not on the checklist, recompute the total as `max(foreground serial chain, longest background chain)` — the critical path, not the sum — folding in the checklist's own total as one candidate chain. Replace the CLI's total line with this fuller one; name the chain that set the number.

### `--long` rows for session-only work

Append extra rows in the same 7 tab-separated fields the CLI prints (`ORDER OWNER STATUS WORK DETAIL PR/MR ETA`), ASCII only, no embedded tabs or newlines:

- `ORDER`: `-` (these rows have no place in the checklist's plan order).
- `OWNER`: `agent` for work the agent is driving, `user` for an externally gated row (old "waiting on you").
- `STATUS`: one of the checklist's seven words, plus `unknown` for a bg job whose state cannot be read (mirrors the old table's `unknown` status).
- `DETAIL`: CI detail when a PR row has a pipeline (a failed pipeline reads `CI failed: verify:e2e`; a blocked one reads `at production:approve`), else `-`.
- `PR/MR`, `ETA`: same ladder and judgment as before (`<5 min`, `~15 min`, `~30 min`, `~1 hr`, `>1 hr`, `unknown`); `-` when there is none.

Recompute the `#`-prefixed total line (see above) instead of keeping the CLI's own.

## 3. Edge cases

| Case | Behavior |
|---|---|
| Nothing in flight | `stat checklist` already prints one line naming how to add an item; relay it as-is |
| Branch has no PR yet | PR/MR cell `—` (or `-` on `--long`), not an error |
| No git repo, or provider unauthenticated | Skip the PR lookup, cell `—`/`-`, still report the rest. Never hard-fail |
| Job finished (`done`, failed, timed out, `canceled`) | List it once (as a session-only row) with its terminal state so the user learns it landed, then clean it up (section 4); contributes nothing to the total |
| Job `unknown` | `STATUS` `unknown`, `DETAIL`/`Also running` line carries its `logFile` |
| Parked worktree | `STATUS` `parked`, no ETA, excluded from the total |

## 4. Clean up finished jobs

After the report, stop finished background work and drop its records. A job is finished when it has completed, failed, timed out, or been canceled. A `running` job is never touched.

| Substrate | How |
|---|---|
| `dg-skills bg` job (`state` is `done` or `canceled`) | One call: `dg-skills bg prune --cwd "$PWD"`. It removes the records of every job in this tree that is not running, and leaves `running` jobs in `running[]`. It has no per-job filter, so run it only when this tree has no `unknown` job. It matches whole path segments, like the filter in section 1 |
| Claude Code background Agent or Bash shell that reports completed, failed, or timed out | The main loop calls `TaskStop` once for each finished task it listed in the report. `TaskStop` on a task that already ended is harmless |
| Workflow | Not killable as one process. Report it finished; stop nothing |

Rules:

- Clean only rows that show a terminal state. Treat an `unknown` job as unfinished: leave it, and skip `dg-skills bg prune` while this tree has one, because prune would delete the log the user needs to read. Prune also removes the session record that `dg-skills bg update` needs to resume a finished job, so skip it when the user may resume one.
- Subagents cannot call `TaskStop`. Only the main loop does. A subagent reports the finished tasks and stops there.
- The total ignores cleaned jobs.
- Report what was cleaned in one line under the checklist. Default and `--plain` print
  `Cleaned: 3 finished jobs (2 bg records, 1 task stopped). Left running: 1.` On `--long`,
  prefix that sentence with `# ` so `awk -F '\t' '!/^#/'` skips it with the total:
  `# Cleaned: 3 finished jobs (2 bg records, 1 task stopped). Left running: 1.`
  Print nothing when nothing finished.

## 5. Reap leftover processes and stuck loops

After section 4, the main loop does these steps on every `/dg:stat`. A running job or process that makes progress is never touched.

### a. Reap

Run `dg-skills stat reap` (not `--dry-run`) once, from the repo. It stops only:

- Orphans: processes of the current user whose parent is init or the user's `systemd --user`, whose cwd is in this repo or one of its worktrees (or whose command line names a deleted worktree of it), that are older than 10 minutes (`--min-age`), and whose command is on an allowlist of agent tooling: `gh pr checks --watch`, `gh run watch`, `codex review` or `codex exec`, `bun test`, Playwright, a headless Chromium with a temporary `--user-data-dir`, `sleep`, `timeout` around one of these, a non-interactive shell `while`/`until` sleep loop, or a `dg-daemon serve` that does not run from a version under the installed lib directory.
- Allowlisted processes whose cwd is a deleted worktree of this repo, with a live parent or not.
- Stuck `pgrep -f` wait loops of this session (see b).

It never touches running `dg-skills bg` jobs and their children, systemd `.service` units, launchd jobs, the installed `dg-daemon`, the phone listener, service-manager units, Claude Code, Codex, or Grok sessions, editors, interactive shells, other users' processes, or anything off the allowlist. A live `codex review` that another session runs in its scratchpad has a live parent and a cwd outside the repo, so it stays. Before each signal it reads the start time again and skips the process when it changed. It sends SIGTERM, then SIGKILL after 5 seconds.

Print the reap summary line under the checklist. The CLI prints it as its last line, with no `#`. On `--long`, add the `# ` prefix yourself:

`Reaped: 2 processes (1 gh-watch, 1 codex). Skipped: 3.`

Relay the text of that line as is. Report zombies (state `Z`) that it lists with their parent. A zombie cannot be stopped; reaping its parent clears it. If the command fails, report the error in one line and continue.

### b. Stuck loops

- **`pgrep -f` wait loops.** A shell that waits with `until ! pgrep -f "<pattern>"`, `while pgrep -f "<pattern>"`, or `tail --pid=$(pgrep -of "<pattern>")` never ends, because `pgrep -f` also matches the loop's own command line. `stat reap` calls a loop stuck when it is older than 60 minutes (`--loop-min-age`), the pattern matches the loop's own command line, the shell runs only its wait helpers, and no process other than wait loops, their children, and the reap process matches the pattern. It leaves patterns with shell expansions, POSIX classes, or pgrep flags that change matching (such as `-x`) alone. It stops stuck loops of this session, children first. This session is the nearest `claude` or `codex` ancestor of the reap process, or the PID in `--session-pid`. For stuck loops of other sessions it prints `stuck loop <pid> (other session, ...)` and stops nothing. A loop with no session ancestor reads `none session`; only `--pid` stops it. Relay those lines and offer to stop them, once: `dg-skills stat reap --pid <pid>` for one loop, or `--other-sessions` for all loops of other sessions. Run that only after a yes. `--pid` checks the rule again before it signals, and stops the loop shell together with its helper children.
- **Long pipes.** `stat reap` lists a shell of a session that has been in a pipe (such as `rg ... | head`) for over a day as `long pipe <pid>`. Report it only.
- **`dg-skills bg` jobs.** Run `dg-skills stat loops --cwd "$PWD"`. It lists running jobs whose log has not grown for 20 minutes (`--stall`) or that run past 180 minutes (`--max-age`), with the log file and last line. For each one, read the last 30 lines of its log. When the job is clearly stuck (no progress, the same poll or error again and again), run `dg-skills bg cancel <id>` and report it. When you are not sure, report it and leave it.
- **Claude Code background Agents.** An Agent that keeps reporting "waiting on its own background work" with no new result for a long time gets one `SendMessage` that asks for its status and tells it to stop polling. When a later `/dg:stat` still shows no progress, `TaskStop` it.
- **Session cron jobs.** `CronList`. Run `CronDelete` on a job whose target is done or that fires with no effect.
- **Workflows.** Report only.

Subagents cannot call `TaskStop` or `CronDelete`. A subagent reports these items and stops there.

Report what this step stopped in one line after the reap line (also `# `-prefixed on `--long`), for example `Stopped: 1 stuck bg job, 1 Agent, 1 cron job.` Print nothing when nothing stopped.

## Keeping the list current

This mirrors the owner's personal stat skill: **`/dg:stat` itself never calls `stat add`, `stat done`, or `stat status`** — those are for the main loop's normal work, run as it lands, so the checklist stays current without anyone hand-editing the file.

```sh
dg-skills stat add "Phone feature to PR" --status running --eta "~1 hr"
dg-skills stat add "Fix the flaky listener test" --status running --under 1
dg-skills stat add "Approve the Wave 6/7 PR batch" --status blocked-user
dg-skills stat done "Phone feature"
dg-skills stat status "Phone feature" queued --eta "~30 min"
```

- `--eta` accepts only `<5 min`, `~15 min`, `~30 min`, `~1 hr`, `>1 hr` and `unknown`. Any other value fails with a non-zero exit and an error that lists these buckets. Use `>1 hr` for work longer than an hour.
- When you start a task or hand the user a step, `stat add` it with the status that fits (`running`, `queued`, `blocked-user`, `needs-user`); add `--eta <bucket>` when you can estimate.
- When you finish one, `stat done "<match>"`. It matches parents and sub-items by a case-insensitive substring; 0 or 2+ matches is an error listing every candidate, so make the match specific.
- `--at <n>` places a new top-level item at the shown number `n` (default: the end of the plan). A number inside the done range means the first open slot,
  and one past the end appends. It fails with a non-zero exit, writing nothing, when a `needs-user` or `parked` item cannot land there, because those sit
  after the plan. `--under <n|match>` adds it as a sub-item of that open top-level item instead.
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
dg-skills stat checklist -l | awk -F '\t' '!/^#/ && NR>1 {print $4}'
```

The STATUS column, header included:

```sh
dg-skills stat checklist -l | cut -f3
```
