# Stat reap and stuck loops

Section 5 of `/dg:stat`: after the cleanup in section 4, the main loop runs these steps on every `/dg:stat`. A running job or process that makes progress is never touched.

### a. Reap

Run `dg stat reap` (not `--dry-run`) once, from the repo. It stops only:

- Orphans: processes of the current user whose parent is init or the user's `systemd --user`, whose cwd is in this repo or one of its worktrees (or whose command line names a deleted worktree of it), that are older than 10 minutes (`--min-age`), and whose command is on an allowlist of agent tooling: `gh pr checks --watch`, `gh run watch`, `codex review` or `codex exec`, `bun test`, Playwright, a headless Chromium with a temporary `--user-data-dir`, `sleep`, `timeout` around one of these, a non-interactive shell `while`/`until` sleep loop, or a `dg daemon serve` that does not run from a version under the installed lib directory and whose `dg.js` no longer exists (its worktree was deleted).
- A dev daemon whose `dg.js` still exists, in a live worktree, is never stopped by default. `stat reap` prints `dev daemon <pid> (...) from live worktree <path>: not stopped`. Relay that line. Stop it only when the user asks, with `dg stat reap --pid <pid>`.
- Allowlisted processes whose cwd is a deleted worktree of this repo, with a live parent or not.
- Stuck `pgrep -f` wait loops of this session (see b).

It never touches running `dg bg` jobs and their children, systemd `.service` units, launchd jobs, the installed dg daemon, the phone listener, service-manager units, Claude Code, Codex, or Grok sessions, editors, interactive shells, other users' processes, or anything off the allowlist. A live `codex review` that another session runs in its scratchpad has a live parent and a cwd outside the repo, so it stays. Before each signal it reads the start time again and skips the process when it changed. It sends SIGTERM, then SIGKILL after 5 seconds.

Print the reap summary line under the checklist. The CLI prints it as its last line, with no `#`. On `--long`, add the `# ` prefix yourself:

`Reaped: 2 processes (1 gh-watch, 1 codex). Skipped: 3.`

Relay the text of that line as is. Report zombies (state `Z`) that it lists with their parent. A zombie cannot be stopped; reaping its parent clears it. If the command fails, report the error in one line and continue.

### b. Stuck loops

- **`pgrep -f` wait loops.** A shell that waits with `until ! pgrep -f "<pattern>"`, `while pgrep -f "<pattern>"`, or `tail --pid=$(pgrep -of "<pattern>")` never ends, because `pgrep -f` also matches the loop's own command line. `stat reap` calls a loop stuck when it is older than 60 minutes (`--loop-min-age`), the loop's condition is only the pgrep check (an `until` may add `X && ` before `! pgrep`), the script has no `break`, `exit` or `return`, the pattern matches the loop's own command line, the shell runs only its wait helpers, a `tail --pid` child does not wait on a live process outside the loop, and no process other than wait loops, their children, and the reap process matches the pattern. It leaves patterns with shell expansions, POSIX classes, or pgrep flags that change matching (such as `-x`) alone. It stops stuck loops of this session, children first. This session is the nearest `claude` or `codex` ancestor of the reap process, or the PID in `--session-pid`. For stuck loops of other sessions it prints `stuck loop <pid> (other session, ...)` and stops nothing. A loop with no session ancestor reads `none session`; only `--pid` stops it. Relay those lines and offer to stop them, once: `dg stat reap --pid <pid>` for one loop, or `--other-sessions` for all loops of other sessions. Run that only after a yes. `--pid` checks the rule again before it signals, and stops the loop shell together with its helper children.
- **Long pipes.** `stat reap` lists a shell of a session that has been in a pipe (such as `rg ... | head`) for over a day as `long pipe <pid>`. Report it only.
- **`dg bg` jobs.** Run `dg stat loops --cwd "$PWD"`. It lists running jobs whose log has not grown for 20 minutes (`--stall`) or that run past 180 minutes (`--max-age`), with the log file and last line. For each one, read the last 30 lines of its log. When the job is clearly stuck (no progress, the same poll or error again and again), run `dg bg cancel <id>` and report it. When you are not sure, report it and leave it.
- **Claude Code background Agents.** An Agent that keeps reporting "waiting on its own background work" with no new result for a long time gets one `SendMessage` that asks for its status and tells it to stop polling. When a later `/dg:stat` still shows no progress, `TaskStop` it.
- **Session cron jobs.** `CronList`. Run `CronDelete` on a job whose target is done or that fires with no effect.
- **Workflows.** Report only.

Subagents cannot call `TaskStop` or `CronDelete`. A subagent reports these items and stops there.

Report what this step stopped in one line after the reap line (also `# `-prefixed on `--long`), for example `Stopped: 1 stuck bg job, 1 Agent, 1 cron job.` Print nothing when nothing stopped.
