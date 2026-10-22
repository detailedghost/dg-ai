# How the user checks on and retrieves the result

- **Claude background Agent or Bash:** you are notified on completion. Meanwhile the user can ask you to poll BashOutput or report the agent's status. Relay results as they arrive.
- **`~/.dg/bin/dg-skills bg` jobs:**
  - `~/.dg/bin/dg-skills bg list` shows every job with derived `state`, `exitCode`, and any `pendingUpdate`.
  - `~/.dg/bin/dg-skills bg status <id>` shows one job.
  - Read (or `tail -f`) the `logFile` for live or final output.
  - `pendingUpdate`, when not null, is context queued with `~/.dg/bin/dg-skills bg update`. It goes to the backend session once the current run finishes.
  - For a proxy job, `drainOutput` holds the result of the automatic resume that runs when the job ends.

State meaning:

| state | meaning |
|---|---|
| `running` | still going |
| `done` | finished; `exitCode` is real |
| `canceled` | stopped with `~/.dg/bin/dg-skills bg cancel` or `~/.dg/bin/dg-skills bg kill` (or the Claude-native equivalent) |
| `unknown` | no exit was recorded and the job cannot be proven alive (likely killed out of band, or a non-Linux host); read the `logFile` to see how far it got |

## Cancel or kill: stop it

- **Claude Code:** a background **Agent** stops with `TaskStop` (by agentId). A background **Bash** stops by killing that shell. A **Workflow** stops through its own controls; it is not a single killable process.
- **Any other agent:** `~/.dg/bin/dg-skills bg cancel <id>` (alias `~/.dg/bin/dg-skills bg kill <id>`). It sends TERM to the job's own process group and escalates to KILL if the job does not exit promptly. The job then reads as `canceled`. It never signals the caller's process group. Canceling an unknown or finished job is a harmless no-op.

## Update: feed in more context

A detached process cannot take new stdin mid-run, so "update" means different things per substrate.

- **Claude Code, background Agent:** native. `SendMessage` to that agent (by name or agentId) continues it with the new context and keeps its transcript. This is the canonical update.
- **Claude Code, background Bash or Workflow:** not updatable mid-run. Cancel it and relaunch with the fuller task.
- **Any other agent, proxy or agentic job:** `~/.dg/bin/dg-skills bg update <id> '<context>'`.
  - If the job is **still running**, the context is queued. The proxy blocks to completion and cannot take mid-flight input. The job's own completion hook then resumes the backend session with the queued context. `~/.dg/bin/dg-skills bg status` and `~/.dg/bin/dg-skills bg list` show it as `pendingUpdate` until then.
  - If the job is **already finished**, it resumes the session at once as a new chained `bg` job and returns the new job's `id`.
  - The `sessionId` comes from the finished job's log. The proxy prints it only at the end, so a session resumes only after its current run completes. There is nothing to capture at launch.
- **Any other agent, plain shell job (type A):** refused. There is no session or context to feed an `nx test` process. Cancel and relaunch instead.

## Prune: drop a tree's finished job records

`~/.dg/bin/dg-skills bg prune --cwd <dir>` removes the records of every job that is **not running** (done, canceled, or dead with no status) whose recorded `cwd` is `<dir>` or inside it. It clears both roots: the durable log, status and meta files, and the ephemeral pid file.

Job records are global-scope, with no per-project bucket. The scratch and state sweeps reap them only on a 30-day TTL. That is the right default for the main repo. A removed worktree's jobs become unreadable once it is gone, so `/dg:cls` prunes them at teardown.

A **running** job in that tree, or one whose recorded pid is still alive but unverified, is reported in `running[]` and left untouched. Its records are the only handle left for `~/.dg/bin/dg-skills bg cancel <id>`, so deleting them would orphan the process. Cancel it first if you want it gone, then prune again. Containment compares whole path segments, so pruning `/w/foo` never touches a sibling `/w/foobar`.
