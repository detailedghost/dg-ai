---
name: stat
description: Report this session's in-flight work as a priority-ordered checklist, split by status (what the agent is doing, what's queued, what's waiting on the user), plus a critical-path total. Read-only glance, except it stops and removes finished background jobs. Triggers on "/dg:stat", "what's in flight", "where are we at", "status of everything", "show the checklist".
---

# /dg:stat: What's In Flight

A four-keystroke glance at this session's work, rendered as one numbered checklist. **Read-only, with one exception:** it cleans up background jobs that have FINISHED (see section 4). Never edit, commit, push, or resume anything, and **never stop a job that is still running**. If reading cannot answer something, report the gap instead of acting.

First run: install or refresh the CLI when it is missing or too old. Every later call uses the literal path, so each Bash call works alone:

```bash
~/.dg/bin/dg-skills stat --help >/dev/null 2>&1 ||
  curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.19.1/pkg/skills-cli/bootstrap.sh | sh -s -- --cli-only
```

If a step fails, run ~/.dg/bin/dg-skills doctor bg stat vcs-provider worktree.

## Usage

**Usage:** `/dg:stat [-l|--long] [-p|--plain] [--overwatch]`

## Flags

| Flag | Short | Effect | Default |
|---|---|---|---|
| `--long` | `-l` | Print a POSIX tab-separated table instead of the checklist | off (checklist) |
| `--plain` | `-p` | Print an ASCII, GitHub-flavored-markdown checklist instead (pastes cleanly, greps cleanly) | off (emoji checklist) |
| `--overwatch` | none | Publish the lanes to the live overwatch board (see below) | off (terminal checklist) |

Finished-job cleanup (section 4) has no flag. It runs on every `/dg:stat`.

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
1. 🔄 Phone feature to PR [~1 hr]
   1. 🔄 Fix the flaky listener test
2. ⏳ Slice 6 [~15 min]
3. 🛑 Approve the Wave 6/7 PR batch
4. 👀 Sign the vendor form
5. ✅ Sign in to GitHub

Total: ~1 hr (critical path: 1 Phone feature to PR)
```

The same checklist, `--plain`:

```text
1. [ ] running: Phone feature to PR [~1 hr]
   1. [ ] running: Fix the flaky listener test
2. [ ] queued: Slice 6 [~15 min]
3. [ ] blocked-user: Approve the Wave 6/7 PR batch
4. [ ] needs-user: Sign the vendor form
5. [x] done: Sign in to GitHub

# Total: ~1 hr (critical path: 1 Phone feature to PR)
```

The same checklist, `--long` (tab-separated):

```text
ORDER	OWNER	STATUS	WORK	DETAIL	PR/MR	ETA
1	agent	running	Phone feature to PR	-	-	~1 hr
-	agent	running	Fix the flaky listener test	-	-	-
2	agent	queued	Slice 6	-	-	~15 min
3	user	blocked-user	Approve the Wave 6/7 PR batch	-	-	-
4	user	needs-user	Sign the vendor form	-	-	-
5	-	done	Sign in to GitHub	-	-	-
# Total: ~1 hr (critical path: 1 Phone feature to PR)
```

Open items are numbered in priority order (the order they need doing, not insertion time); done items continue the same numbers, newest first, capped. A sub-item nests one level under its parent and restarts its own number at 1 in the default and `--plain` views. On `--long`, a sub-item row carries `-` in `ORDER` instead and prints directly under its parent, in stored order — rows already print in priority order, so there is nothing to sort. When a sub-item is the critical path, that total reads `(critical path: <text>, under <parent number>)`, using the parent number visible in ORDER. A sub-item can be ticked on its own; ticking a parent does not tick its sub-items, and finishing every sub-item does not tick the parent — mark each explicitly. User items (`blocked-user`/`needs-user`) never show an ETA, because the wait is on the user, not the agent.

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
jobs=$(~/.dg/bin/dg-skills bg list 2>/dev/null | jq -c --arg d "$PWD" '[.jobs[]|select(.cwd==$d or ((.cwd // "")|startswith($d+"/")))|{id,state,exitCode,logFile,cmd:.command[0:60]}]' 2>/dev/null)
echo "JOBS=${jobs:-[]}"
echo "WORKTREES=$(~/.dg/bin/dg-skills worktree list --porcelain 2>/dev/null | tr '\n' ' ')"
checklist=$(~/.dg/bin/dg-skills stat checklist --json 2>/dev/null)
echo "CHECKLIST=${checklist:-null}"
```

`~/.dg/bin/dg-skills bg list` is machine-wide with no `--cwd` filter. The jq `select` keeps it from dumping every job ever launched. It matches the directory or a path inside it, never a sibling like `/repo-other`. PR lookup goes through `~/.dg/bin/dg-skills vcs-provider`, never `gh` or `glab` directly. The checklist is per repo (shared by linked worktrees) or per cwd outside a repo; `~/.dg/bin/dg-skills stat checklist` already orders, numbers, and totals it, so this gather step only needs its JSON for merging.

Then add what only you know: your current foreground task, how far into it you are, and any subagent or background work this session launched that is not yet on the checklist.

## 2. Report

Print the checklist view the caller asked for, as the CLI renders it. With no flag this is `~/.dg/bin/dg-skills stat checklist`; `--plain` adds `-p`; `--long` adds `-l`.

The CLI already handles ordering, numbering, sub-items, the done cap, and a Total line computed from the checklist's own unfinished agent items — sub-items included, even under a done parent, and parked work excluded. Two things are still judgment, left to the main loop:

- **Session-only work not yet on the list.** Prefer adding it first (see "Keeping the list current" below), so the checklist already reflects it. If you do not, append a short, plain trailer after the CLI's own output: `Also running, not on the list:` followed by one line per item. Do this for the default and `--plain` views; for `--long`, append the same items as additional rows (see below) instead.
- **A fuller critical-path total.** The CLI's `Total:`/`# Total:` line is computed from checklist agent ETAs alone. When this session also has foreground or background work not on the checklist, recompute the total as `max(foreground serial chain, longest background chain)` — the critical path, not the sum — folding in the checklist's own total as one candidate chain. Replace the CLI's total line with this fuller one; name the chain that set the number.

### `--long` rows for session-only work

Append extra rows in the same 7 tab-separated fields the CLI prints (`ORDER OWNER STATUS WORK DETAIL PR/MR ETA`), ASCII only, no embedded tabs or newlines:

- `ORDER`: `-` (these rows have no place in the checklist's priority order).
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
| `~/.dg/bin/dg-skills bg` job (`state` is `done` or `canceled`) | One call: `~/.dg/bin/dg-skills bg prune --cwd "$PWD"`. It removes the records of every job in this tree that is not running, and leaves `running` jobs in `running[]`. It has no per-job filter, so run it only when this tree has no `unknown` job. It matches whole path segments, like the filter in section 1 |
| Claude Code background Agent or Bash shell that reports completed, failed, or timed out | The main loop calls `TaskStop` once for each finished task it listed in the report. `TaskStop` on a task that already ended is harmless |
| Workflow | Not killable as one process. Report it finished; stop nothing |

Rules:

- Clean only rows that show a terminal state. Treat an `unknown` job as unfinished: leave it, and skip `~/.dg/bin/dg-skills bg prune` while this tree has one, because prune would delete the log the user needs to read. Prune also removes the session record that `~/.dg/bin/dg-skills bg update` needs to resume a finished job, so skip it when the user may resume one.
- Subagents cannot call `TaskStop`. Only the main loop does. A subagent reports the finished tasks and stops there.
- The total ignores cleaned jobs.
- Report what was cleaned in one line under the checklist. Default and `--plain` print
  `Cleaned: 3 finished jobs (2 bg records, 1 task stopped). Left running: 1.` On `--long`,
  prefix that sentence with `# ` so `awk -F '\t' '!/^#/'` skips it with the total:
  `# Cleaned: 3 finished jobs (2 bg records, 1 task stopped). Left running: 1.`
  Print nothing when nothing finished.

## Keeping the list current

This mirrors the owner's personal stat skill: **`/dg:stat` itself never calls `stat add`, `stat done`, or `stat status`** — those are for the main loop's normal work, run as it lands, so the checklist stays current without anyone hand-editing the file.

```sh
~/.dg/bin/dg-skills stat add "Phone feature to PR" --status running --eta "~1 hr"
~/.dg/bin/dg-skills stat add "Fix the flaky listener test" --status running --under 1
~/.dg/bin/dg-skills stat add "Approve the Wave 6/7 PR batch" --status blocked-user
~/.dg/bin/dg-skills stat done "Phone feature"
~/.dg/bin/dg-skills stat status "Phone feature" queued --eta "~30 min"
```

- When you start a task or hand the user a step, `stat add` it with the status that fits (`running`, `queued`, `blocked-user`, `needs-user`); add `--eta <bucket>` when you can estimate.
- When you finish one, `stat done "<match>"`. It matches parents and sub-items by a case-insensitive substring; 0 or 2+ matches is an error listing every candidate, so make the match specific.
- `--at <n>` places a new top-level item at position `n` (default: the end); `--under <n|match>` adds it as a sub-item of that open top-level item instead.
- There is no separate `reopen` command: `stat status "<match>" queued` (or any open status) moves a done item back to the end of the open list.

## `--overwatch`

A second exception to read-only: it publishes this session's work to the live overwatch board in the dg extension.

1. Load the `/dg:overwatch` skill and follow it. It owns the session start, the lane publish commands and the board open step. Publish one lane per checklist item and per session-only row, with its task, stage, MR, ETA and next step.
2. Open or focus the board tab as `/dg:overwatch` describes.
3. Republish the phone snapshot as `/dg:overwatch` describes (throttled, same artifact url).

If the overwatch agent binary is missing or the daemon is down, say so in one line and fall back to the plain checklist.

## Piping `--long`

Its output is POSIX: tab-separated fields, one header line, ASCII only, no embedded tabs or newlines, and a final `#`-prefixed total line a pipeline can skip.

The section 4 cleanup summary is a `#`-prefixed line on `--long` too, so the same filter skips it.

Rows already print in priority order — a sub-item's row follows its parent's directly, so no sort step is needed.

The WORK column:

```sh
~/.dg/bin/dg-skills stat checklist -l | awk -F '\t' '!/^#/ && NR>1 {print $4}'
```

The STATUS column, header included:

```sh
~/.dg/bin/dg-skills stat checklist -l | cut -f3
```
