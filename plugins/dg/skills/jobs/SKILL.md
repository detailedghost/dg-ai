---
name: jobs
description: List and control the dg daemon (scheduled jobs and long-running services) and the channel-review daemon. Read-only by default; starting, stopping, or restarting any of them needs a named target.
  Also adds and removes services, runs a job now, and starts, stops or restarts
  the dg daemon, each only on a request from the human that names the target.
---

# Jobs

This skill is a thin front end over two existing daemons. It adds no new
commands to either one; it only calls what `dg job`, `dg service` and
`dg channel-review` already expose.

Commands use the compiled binary `dg`. Bootstrap once if
needed; the default installer (no `--cli-only`) pulls it with the extension:

```sh
{ dg daemon --help >/dev/null 2>&1 &&
  dg --version >/dev/null 2>&1; } ||
  { "${DG_HOME:-$HOME/.local}/bin/dg" daemon --help >/dev/null 2>&1 &&
  "${DG_HOME:-$HOME/.local}/bin/dg" --version >/dev/null 2>&1; } ||
  { { dg --version >/dev/null 2>&1 || "${DG_HOME:-$HOME/.local}/bin/dg" --version >/dev/null 2>&1; } && echo "run dg upgrade"; } ||
  curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh
```

Call `dg` in every later step. If `dg` alone does not answer, also after the bootstrap, call `${DG_HOME:-$HOME/.local}/bin/dg` instead.

If a step fails, run dg doctor channel-review.

## Status (default, read-only)

When invoked with no action, report status only. Run all that apply and show
each command's own JSON; do not reshape it or add fields it does not already
print:

```sh
dg job list
dg service status
dg channel-review status --env dev
dg channel-review status --env prod
```

`job list` reads the daemon's store directly and works with no daemon running.
`service status` needs a live daemon and calls it over loopback; with none
running it fails cleanly with
`no live dg daemon — services run inside it, so start it with dg daemon start`
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
from `dg service status` (for example `bot`). There is no default
target and no "restart everything."

For each job verb, see [Job verbs](#job-verbs).

| Action | Channel-review target | Service target |
| --- | --- | --- |
| Start | `dg channel-review start --env <env>` | `dg service start <label>` |
| Stop | `dg channel-review stop --env <env>` | `dg service stop <label>` |

A scheduled job (from `job list`) is not started or stopped here; use
`dg job enable|disable|run <label>` or `dg job exec <label>`
directly for those, outside this skill.

### Add and remove a service

Run these only on a request from the human that names the label. A `service
add` request also needs the argv and `--cwd` from the human; never invent them.

```sh
dg service add <label> --cwd <absolute-path> -- <command> [args...]
dg service rm <label>
```

`service add` also takes `--autostart`, `--env-file <path>`, `--pass-env
<NAME>`, `--stop-timeout <duration>` and `--grant <prefix>`; pass one only when
the human names it. Both commands edit the daemon config and work with no
daemon running. `service rm` refuses a service that is running. This skill
does not stop a running service to make `service rm` pass; tell the human to
ask for the stop.

### Start, stop or restart the dg daemon

Run these only on a request from the human that names the dg daemon:

```sh
dg daemon start
dg daemon stop
dg daemon restart
```

`dg daemon start` is idempotent and starts the daemon in the background, or
reports the one that runs. Before a stop or a restart, tell the human that each
service stops and each session ends, then wait for the go-ahead. A regular
stop waits for the `stopTimeoutMs` of each service. This skill uses `--force`
only when the human says so; it kills the daemon and each service process tree
at once. A `restart` starts only the `autostart` services.

### Restart

A service restart is stop then start; a generic service holds no in-flight
review, so there is nothing to wait for.

A `channel-review-<env>` restart must not drop a review in progress:

1. Run `dg channel-review status --env <env>` and read `current`.
2. If `current` is `null`, stop then start that env and report done.
3. If `current` is not `null`, wait and re-check every 15 seconds, for up to
   2 minutes total.
4. If `current` becomes `null` within that window, stop then start and report
   done.
5. If `current` is still not `null` after 2 minutes, stop waiting. Tell the
   human which PR or MR `current.url` points at and how long it has run
   (`current.startedAt`), and ask whether to restart anyway and drop that job,
   or wait longer. Do not stop or start until they answer.

## Job verbs

`dg job` manages each job, continuous or scheduled, with these verbs:

```sh
dg job list
dg job status [<name>] [--json]
dg job add --name <name> --cwd <absolute-path> --continuous -- <command> [args...]
dg job add --name <name> --cwd <absolute-path> --every <duration> [--feed] -- <command> [args...]
dg job add --name <name> --cwd <absolute-path> --schedule "<cron>" [--feed] -- <command> [args...]
dg job add <url>
dg job add <path>
dg job update <name> --every <duration>
dg job enable <name>
dg job enable <name> --setup <file|->
dg job setup <name>
dg job setup <name> --refresh
dg job disable <name>
dg job start <name>
dg job stop <name>
dg job restart <name>
dg job remove <name>
dg job logs <name> [-n <lines>] [-f]
```

`list`, `status` and `logs` are read-only. Run each other verb only on a
request from the human that names the job. An `add` request also needs the
argv and `--cwd` from the human; never invent them. `add` also takes
`--timeout <duration>`, `--notify <identity>`, `--env-file <path>`,
`--env <NAME>` and `--stop-timeout <duration>`; pass one only when the human
names it. `update` takes one mode flag (`--continuous`, `--schedule` or
`--every`) and `--timeout`, `--feed` and `--notify`.

`add` writes a job that is not enabled. `enable` turns it on and starts the
daemon when none runs. `start`, `stop` and `restart` act now only and need a
live daemon. `remove`, `disable` and `autostart install|remove` need a request
from the human that names the job or the login unit.

`job add <url>` takes a repository (`<git-url>[@ref]`) and `job add <path>` takes a script or a
folder. A repository job asks for consent: `add` and `update` print the request and ask at a
terminal. This skill does not answer the consent question and does not add `--yes` on its own.
It gives the command, and the human runs it. The agent never adds `--yes`, because with `--yes` a
process runs repository code with no question. A local path asks nothing, but run it only on a request that names the path.

`job setup <name>` asks questions at a terminal, so give the command to the human.
`job setup <name> --refresh` fetches each credential of the job again from its declared
source; run it only on a request that names the job, and then give the command
`job restart <name>` that it prints. A prefix that already holds credentials needs one `y` at a terminal, also for an agent,
so this skill does not answer that question either. `job enable <name> --setup <file|->` takes
a file path or `-` and never JSON text; never write a secret on a command line.

The first `job enable` at a terminal asks whether to start dg at login. This
skill does not answer the login unit question of `job enable`: the human
answers it. `enable` with no terminal only prints the hint
`hint: dg does not start at login — run dg autostart install`; report the hint
and do not run `autostart install` on your own.

## Autostart

This skill never edits `~/.claude/settings.json` or any other file outside
this repository. To autostart a channel-review env at the beginning of a
Claude Code session, print the block below for the human to paste into their
own `~/.claude/settings.json` themselves, with `<env>` replaced by `dev` or
`prod`. When `DG_HOME` is set to a relative path, replace
`${DG_HOME:-$HOME/.local}/bin/dg` with the absolute launcher path
before you print the block, because each session starts in its own folder:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"${DG_HOME:-$HOME/.local}/bin/dg\" channel-review start --env <env> >/dev/null 2>&1"
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
already-running case quiet. There is no autostart for the dg daemon itself until the human runs `dg autostart install`: `dg agent start` and
`dg daemon start` start it, and no other `dg` command does.
