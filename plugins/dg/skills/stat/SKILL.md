---
name: stat
description: Report this session's in-flight work as a priority-ordered checklist, split by status (doing, queued, waiting on the user), plus a critical-path total. Read-only glance, except it removes finished background jobs, reaps leftover agent processes, and stops stuck loops. Triggers on "/dg:stat", "what's in flight", "where are we at", "status of everything", "show the checklist".
---

# /dg:stat: What's In Flight

A glance at this session's work as one numbered checklist. **Read-only, with three exceptions:** it cleans up FINISHED background jobs (section 4), reaps leftover agent processes, and stops clearly stuck work (section 5). Never edit, commit, push, or resume anything, and **never stop a running job that makes progress**. If reading cannot answer something, report the gap instead of acting.

First run: the block installs the CLI when it is missing. It prints an upgrade hint when the CLI is too old. Each Bash call works alone:

```bash
dg stat --help >/dev/null 2>&1 ||
  "${DG_HOME:-$HOME/.local}/bin/dg" stat --help >/dev/null 2>&1 ||
  { { dg --version >/dev/null 2>&1 || "${DG_HOME:-$HOME/.local}/bin/dg" --version >/dev/null 2>&1; } && echo "run dg upgrade"; } ||
  curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh -s -- --cli-only
```

Call `dg` in every later step. If `dg` alone does not answer, also after the bootstrap, call `${DG_HOME:-$HOME/.local}/bin/dg` instead. If the block prints "run dg upgrade", run `dg upgrade`, then run the step again.

If a step fails, run dg doctor bg stat vcs-provider worktree.

## Usage

**Usage:** `/dg:stat [-l|--long] [-p|--plain] [--overwatch]`

## Flags

| Flag | Short | Effect | Default |
|---|---|---|---|
| `--long` | `-l` | Print a POSIX tab-separated table | off (checklist) |
| `--plain` | `-p` | Print an ASCII, GitHub-flavored-markdown checklist | off (emoji checklist) |
| `--overwatch` | none | Publish the lanes to the overwatch board on the daemon /board page | off (terminal checklist) |

Sections 4 and 5 have no flag. They run on every `/dg:stat`.

## Statuses

One status per item sets its emoji (default view), its word (`--plain`, `--long`), and its owner. `--plain` keeps `[ ]`/`[x]`, with `[x]` only for `done`:

| Status | Emoji | Owner | Meaning |
|---|---|---|---|
| `queued` | ⏳ | agent | Waits on another item or a time |
| `running` | 🔄 | agent | An agent is working on it now |
| `blocked-user` | 🛑 | user | Agent work cannot continue until the user acts |
| `needs-user` | 👀 | user | The user should do it, but nothing is waiting on it |
| `parked` | ⏸️ | agent | Paused, not currently being worked |
| `failed` | ❌ | agent | Attempted and failed |
| `done` | ✅ | — | Finished; a done item's earlier owner is not retained |

View examples, plan ordering and sub-items: [references/views.md](references/views.md).

## 1. Gather: one Bash call, filtered in the shell

Filters run in the shell, so only the small result enters context. Never echo this raw output to the user. Each call fails soft: a missing CLI, no repo, or no provider auth gives `[]`, never an error.

```sh
b=$(git branch --show-current 2>/dev/null)
echo "BRANCH=${b:-none}"
prs=
if [ -n "$b" ]; then
  prs=$(dg vcs-provider list-prs --head "$b" 2>/dev/null | jq -c '[.[]|{number,state,title}]' 2>/dev/null)
fi
echo "PRS=${prs:-[]}"
jobs=$(dg bg list --cwd "$PWD" 2>/dev/null | jq -c '[.jobs[]|{id,state,exitCode,logFile,cmd:.command[0:60]}]' 2>/dev/null)
echo "JOBS=${jobs:-[]}"
echo "WORKTREES=$(dg worktree list --porcelain 2>/dev/null | tr '\n' ' ')"
checklist=$(dg stat checklist --json 2>/dev/null)
echo "CHECKLIST=${checklist:-null}"
```

`dg bg list` is machine-wide; `--cwd "$PWD"` limits it to this directory or a path inside it, never a sibling like `/repo-other`. PR lookup goes through `dg vcs-provider`, never `gh` or `glab`. The checklist is per repo (shared by linked worktrees) or per cwd outside a repo, and `dg stat checklist` already orders, numbers, and totals it.

Then add what only you know: your foreground task, its progress, and subagent or background work not yet on the checklist.

## 2. Report

Print the checklist view the caller asked for, as the CLI renders it: `dg stat checklist`, with `-p` for `--plain` and `-l` for `--long`. The CLI orders, numbers and totals the list. Three judgment calls stay with the main loop:

- **Waiting on the user.** Keep the CLI's `Waiting on you: N items.` line. Offer once to hand those items to `/dg:walk stat`. Do not start the walk without a yes.
- **Session-only work.** Prefer `stat add` first. Otherwise append `Also running, not on the list:` with one line per item (extra rows on `--long`).
- **A fuller total.** When session work is off the checklist, recompute the total as `max(foreground serial chain, longest background chain)` and name the chain.

Edge cases (no PR, no repo, finished or `unknown` job, parked worktree) in [references/report.md](references/report.md); `--long` row rules in [references/views.md](references/views.md).

## 4. Clean up finished jobs

After the report, stop finished background work and drop its records. A job is finished when it has completed, failed, timed out, or been canceled. A `running` job is never touched.

- `dg bg` job in `done` or `canceled`: run `dg bg prune --cwd "$PWD"` once. Skip it while this tree has an `unknown` job or when the user may resume a finished job.
- Claude Code background Agent or Bash shell that finished: the main loop calls `TaskStop` once per finished task. Subagents cannot call `TaskStop`; they report and stop.
- Workflow: report it; stop nothing.

Report it in one line under the checklist (`# `-prefixed on `--long`, so `awk -F '\t' '!/^#/'` skips it). Print nothing when nothing finished. Default and `--plain`:
`Cleaned: 3 finished jobs (2 bg records, 1 task stopped). Left running: 1.`
On `--long`:
`# Cleaned: 3 finished jobs (2 bg records, 1 task stopped). Left running: 1.`

Full rules: [references/report.md](references/report.md).

## 5. Reap leftover processes and stuck loops

After section 4, the main loop does these steps on every `/dg:stat`. A running job or process that makes progress is never touched.

1. Run `dg stat reap` (not `--dry-run`) once, from the repo. It stops only allowlisted orphan agent tooling and processes of deleted worktrees of this repo. It never touches running `dg bg` jobs, service units, the installed dg daemon, the phone listener, agent sessions, editors, interactive shells, other users' processes, or a dev daemon from a live worktree (stop that only on request: `dg stat reap --pid <pid>`).
2. Print its last line under the checklist (add `# ` on `--long`): `Reaped: 2 processes (1 gh-watch, 1 codex). Skipped: 3.` Relay it as is. Report listed zombies with their parent. If the command fails, report the error in one line and continue.
3. Handle stuck loops: `pgrep -f` wait loops, long pipes, stalled `dg bg` jobs (`dg stat loops --cwd "$PWD"`), silent background Agents, and cron jobs with no effect. Stop only what is clearly stuck.
4. Subagents cannot call `TaskStop` or `CronDelete`; they report and stop.
5. Report what step 3 stopped in one line (`# `-prefixed on `--long`), for example `Stopped: 1 stuck bg job, 1 Agent, 1 cron job.` Print nothing when nothing stopped.

The full allowlist, the exact stuck-loop rules, and the offer to stop loops of other sessions: [references/reap.md](references/reap.md). Read it before you stop anything.

## Keeping the list current

`/dg:stat` itself never calls `stat add`, `stat done`, or `stat status`. The main loop runs them as work lands: `dg stat add "<text>" --status running --eta "~1 hr"`, `dg stat done "<match>"`, `dg stat status "<match>" queued`. `--eta` accepts only `<5 min`, `~15 min`, `~30 min`, `~1 hr`, `>1 hr` and `unknown`.

Placement flags, `stat archive`, reopening, the `--overwatch` publish flow and `--long` piping recipes: [references/maintain.md](references/maintain.md). With `--overwatch`, load `/dg:overwatch`, publish one lane per item, and fall back to the plain checklist in one line when the board is unavailable.
