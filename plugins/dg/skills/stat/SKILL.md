---
name: stat
description: Report this session's in-flight work as a table with what is running, its status, the PR/MR number, and a bucketed ETA, plus a critical-path total. Read-only glance, except it stops and removes finished background jobs. Triggers on "/dg:stat", "what's in flight", "where are we at", "status of everything".
---

# /dg:stat: What's In Flight

A four-keystroke glance at this session's work. **Read-only, with one exception:** it cleans up background jobs that have FINISHED (see section 4). Never edit, commit, push, or resume anything, and **never stop a job that is still running**. If reading cannot answer something, report the gap instead of acting.

First run: install or refresh the CLI when it is missing or too old. Every later call uses the literal path, so each Bash call works alone:

```bash
~/.dg/bin/dg-skills bg --help >/dev/null 2>&1 ||
  curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.18.0/pkg/skills-cli/bootstrap.sh | sh -s -- --cli-only
```

If a step fails, run ~/.dg/bin/dg-skills doctor bg vcs-provider worktree.

## Usage

**Usage:** `/dg:stat [--overwatch]`

## Flags

| Flag | Short | Effect | Default |
|---|---|---|---|
| `--overwatch` | none | Publish the lanes to the live overwatch board (see below). | off (terminal table) |

Finished-job cleanup (section 4) has no flag. It runs on every `/dg:stat`.

## 1. Gather: one Bash call, filtered in the shell

Every filter runs in the shell, so only the small result enters context. Never echo this raw output back to the user. Each CLI call fails soft: a missing CLI, no repo, or an unauthenticated provider gives `[]`, never an error.

```sh
b=$(git branch --show-current 2>/dev/null)
echo "BRANCH=${b:-none}"
prs=
if [ -n "$b" ]; then
  prs=$(~/.dg/bin/dg-skills vcs-provider list-prs --head "$b" 2>/dev/null | jq -c '[.[]|{number,state,title}]' 2>/dev/null)
fi
echo "PRS=${prs:-[]}"
jobs=$(~/.dg/bin/dg-skills bg list 2>/dev/null | jq -c --arg d "$PWD" '[.jobs[]|select(.cwd==$d or (.cwd|startswith($d+"/")))|{id,state,exitCode,logFile,cmd:.command[0:60]}]' 2>/dev/null)
echo "JOBS=${jobs:-[]}"
echo "WORKTREES=$(~/.dg/bin/dg-skills worktree list --porcelain 2>/dev/null | tr '\n' ' ')"
```

`~/.dg/bin/dg-skills bg list` is machine-wide with no `--cwd` filter. The jq `select` keeps it from dumping every job ever launched. It matches the directory or a path inside it, never a sibling like `/repo-other`. PR lookup goes through `~/.dg/bin/dg-skills vcs-provider`, never `gh` or `glab` directly.

Then add what only you know: your current foreground task and how far into it you are.

## 2. Report

| Work | Status | Detail | PR/MR | ETA |
|---|---|---|---|---|

- **Rows:** foreground work, async work this session launched (subagents, background Bash, bg jobs), and worktrees this session created. Not repo-wide PRs.
- **Status:** exactly one of `running`, `blocked`, `review`, `parked`, `done`, `unknown`. The qualifier belongs in Detail, never in Status.
- **ETA ladder:** `<5 min`, `~15 min`, `~30 min`, `~1 hr`, `>1 hr`. Never invent precision. If you truly cannot tell, write `unknown`, not a guess.
- **Externally gated rows** print the blocker (`waiting on you`, `waiting on CI`) instead of a number, so they cannot poison the total.
- **Total** is `max(foreground serial chain, longest background chain)`. It is the critical path, not the sum, because background work runs alongside foreground work. Count only agent-controlled rows and name the chain that set the number.

## 3. Edge cases

| Case | Behavior |
|---|---|
| Nothing in flight | One line: `Nothing in flight.` No empty table |
| Branch has no PR yet | PR/MR cell `—`, not an error |
| No git repo, or provider unauthenticated | Skip the PR lookup, cell `—`, still report the rest. Never hard-fail |
| Job finished (`done`, failed, timed out, `canceled`) | List once with its terminal state so the user learns it landed, then clean it up (section 4). It adds 0 to the Total |
| Job `unknown` | Status `unknown`, Detail carries its `logFile` |
| Parked worktree | Status `parked`, ETA `—`, excluded from the Total |

## 4. Clean up finished jobs

After the table, stop finished background work and drop its records. A job is finished when it has completed, failed, timed out, or been canceled. A `running` job is never touched.

| Substrate | How |
|---|---|
| `~/.dg/bin/dg-skills bg` job (`state` is `done` or `canceled`) | One call: `~/.dg/bin/dg-skills bg prune --cwd "$PWD"`. It removes the records of every job in this tree that is not running, and leaves `running` jobs in `running[]`. It has no per-job filter, so run it only when this tree has no `unknown` job. It matches whole path segments, like the filter in section 1 |
| Claude Code background Agent or Bash shell that reports completed, failed, or timed out | The main loop calls `TaskStop` once for each finished task it listed in the table. `TaskStop` on a task that already ended is harmless |
| Workflow | Not killable as one process. Report it finished; stop nothing |

Rules:

- Clean only rows that show a terminal state. Treat an `unknown` job as unfinished: leave it, and skip `~/.dg/bin/dg-skills bg prune` while this tree has one, because prune would delete the log the user needs to read. Prune also removes the session record that `~/.dg/bin/dg-skills bg update` needs to resume a finished job, so skip it when the user may resume one.
- Subagents cannot call `TaskStop`. Only the main loop does. A subagent reports the finished tasks and stops there.
- The Total ignores cleaned jobs.
- Report what was cleaned in one line under the table: `Cleaned: 3 finished jobs (2 bg records, 1 task stopped). Left running: 1.` Print nothing when nothing finished.

## `--overwatch`

A second exception to read-only: it publishes this session's work to the live overwatch board in the dg extension.

1. Load the `/dg:overwatch` skill and follow it. It owns the session start, the lane publish commands and the board open step. Publish one lane per item from section 2, with its task, stage, MR, ETA and next step.
2. Open or focus the board tab as `/dg:overwatch` describes.
3. Republish the phone snapshot as `/dg:overwatch` describes (throttled, same artifact url).

If the overwatch agent binary is missing or the daemon is down, say so in one line and fall back to the plain table.

## Why there is no stat command

The deterministic surface is already built: `~/.dg/bin/dg-skills worktree list`, `~/.dg/bin/dg-skills bg list` and `~/.dg/bin/dg-skills bg prune`, and `~/.dg/bin/dg-skills vcs-provider list-prs --head`. What is left (what counts as an item, its status, its ETA) is judgment, not code.
