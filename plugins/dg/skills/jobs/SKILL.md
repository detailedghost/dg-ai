---
name: jobs
description: List and control the generic dg-daemon (scheduled jobs and long-running services) and the channel-review daemon. Read-only by default; starting, stopping, or restarting any of them needs a named target.
  Also adds and removes services, runs a job now, and starts, stops or restarts
  dg-daemon, each only on a request from the human that names the target.
---

# Jobs

This skill is a thin front end over two existing daemons. It adds no new
commands to either one; it only calls what `dg-daemon` and
`dg-skills channel-review` already expose.

Commands use the compiled binaries `dg-daemon` and
`dg-skills`. Bootstrap once if needed; the default installer (no
`--cli-only`) pulls both, alongside `dg-agent`:

```sh
{ dg-daemon --version >/dev/null 2>&1 &&
  dg-skills --version >/dev/null 2>&1; } ||
  { "${DG_HOME:-$HOME/.local}/bin/dg-daemon" --version >/dev/null 2>&1 &&
  "${DG_HOME:-$HOME/.local}/bin/dg-skills" --version >/dev/null 2>&1; } ||
  curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh
```

Call `dg-daemon` and `dg-skills` in every later step. If a bare name does not answer, also after the bootstrap, call it by its `${DG_HOME:-$HOME/.local}/bin` path instead.

If a step fails, run dg-skills doctor channel-review.

## Status (default, read-only)

When invoked with no action, report status only. Run all that apply and show
each command's own JSON; do not reshape it or add fields it does not already
print:

```sh
dg-daemon job list
dg-daemon service status
dg-skills channel-review status --env dev
dg-skills channel-review status --env prod
```

`job list` reads the daemon's store directly and works with no daemon running.
`service status` needs a live daemon and calls it over loopback; with none
running it fails cleanly with
`no live dg-daemon — services run inside it, so start it with dg-daemon start`
instead of starting one. Report that message as the service
section's status, and do not start the daemon yourself to work around it —
that is a `start` action, not part of a status check.

Skip an env the human does not use. `channel-review status`'s `credentials`
field already holds only redacted source/expiry metadata, never a secret
value, so it is safe to show as printed. Do not read or print
`$DG_HOME/channel-review/config.json` to answer a status question; the CLI
output above is enough.

## Start, stop, restart (each needs a named target)

None of these three run with no argument. The target is either a channel-review
env, written `channel-review-dev` or `channel-review-prod`, or a service label
from `dg-daemon service status` (for example `teams-bot`). There is no default
target and no "restart everything."

| Action | Channel-review target | Service target |
| --- | --- | --- |
| Start | `dg-skills channel-review start --env <env>` | `dg-daemon service start <label>` |
| Stop | `dg-skills channel-review stop --env <env>` | `dg-daemon service stop <label>` |

A scheduled job (from `job list`) is not started or stopped here; use
`dg-daemon job enable|disable|run <label>` or `dg-daemon job exec <label>`
directly for those, outside this skill.

### Add and remove a service

Run these only on a request from the human that names the label. A `service
add` request also needs the argv and `--cwd` from the human; never invent them.

```sh
dg-daemon service add <label> --cwd <absolute-path> -- <command> [args...]
dg-daemon service rm <label>
```

`service add` also takes `--autostart`, `--env-file <path>`, `--pass-env
<NAME>`, `--stop-timeout <duration>` and `--grant <prefix>`; pass one only when
the human names it. Both commands edit the daemon config and work with no
daemon running. `service rm` refuses a service that is running. This skill
does not stop a running service to make `service rm` pass; tell the human to
ask for the stop.

### Start, stop or restart dg-daemon itself

Run these only on a request from the human that names `dg-daemon`:

```sh
dg-daemon start
dg-daemon stop
dg-daemon restart
```

`dg-daemon start` is idempotent and starts the daemon in the background, or
reports the one that runs. Before a stop or a restart, tell the human that each
service stops and each session ends, then wait for the go-ahead. A regular
stop waits for the `stopTimeoutMs` of each service. This skill uses `--force`
only when the human says so; it kills the daemon and each service process tree
at once. A `restart` starts only the `autostart` services.

### Restart

A service restart is stop then start; a generic service holds no in-flight
review, so there is nothing to wait for.

A `channel-review-<env>` restart must not drop a review in progress:

1. Run `dg-skills channel-review status --env <env>` and read `current`.
2. If `current` is `null`, stop then start that env and report done.
3. If `current` is not `null`, wait and re-check every 15 seconds, for up to
   2 minutes total.
4. If `current` becomes `null` within that window, stop then start and report
   done.
5. If `current` is still not `null` after 2 minutes, stop waiting. Tell the
   human which PR or MR `current.url` points at and how long it has run
   (`current.startedAt`), and ask whether to restart anyway and drop that job,
   or wait longer. Do not stop or start until they answer.

## Autostart

This skill never edits `~/.claude/settings.json` or any other file outside
this repository. To autostart a channel-review env at the beginning of a
Claude Code session, print the block below for the human to paste into their
own `~/.claude/settings.json` themselves, with `<env>` replaced by `dev` or
`prod`. When `DG_HOME` is set to a relative path, replace
`${DG_HOME:-$HOME/.local}/bin/dg-skills` with the absolute launcher path
before you print the block, because each session starts in its own folder:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"${DG_HOME:-$HOME/.local}/bin/dg-skills\" channel-review start --env <env> >/dev/null 2>&1"
          }
        ]
      }
    ]
  }
}
```

`channel-review start` already refuses a second start against a pid it finds
running and exits nonzero without starting a duplicate, so this hook is safe
to run on every session start; the redirect only keeps that expected
already-running case quiet. There is no autostart for `dg-daemon` itself: `dg-agent start` and
`dg-daemon start` start it, and `dg-skills` does not.
