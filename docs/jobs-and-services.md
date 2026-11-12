# Scheduled jobs and services

Have the daemon **poll something on a schedule** — a Jira board, a Sentry issue
feed, a Datadog monitor — and collect what comes back:

```sh
dg-daemon job add --label jira-sprint --every 15m --cwd ~/work \
  --notify reviewer -- jira issue list --plain --jsonlines
```

Give the job a fixed cadence with `--every` (`30s`, `15m`, `2h`), or a real
`cron` expression with `--cron` — exactly one of the two is required:

```sh
dg-daemon job add --label weekday-standup --cron "0 9 * * 1-5" --cwd ~/work \
  -- bun run ./check-standup.ts
```

The command prints one JSON object per line — `id` and `title` required, `meta`
and `url` optional — and each line becomes a feed item. The daemon dedupes on
`id`, so a second run of the same query adds nothing. `--notify <identity>`
queues one agent message when a run brings in something new. `job list`, `job run` (also `job exec`), `job enable`, `job disable` and `job rm` manage them from there.

Phone (`dg-agent phone`) no longer delivers through a job like this: `phone
open` keeps its own always-on listener running instead, through the OS's
own service manager. See [Phone](phone.md).

A job inherits no secrets: the daemon passes only `PATH`, `HOME`, `LANG` and
`TZ` to the child, so the command must authenticate through its own config
under `HOME` (`~/.sentryclirc`, `~/.config/jira`, and so on). While any job is
enabled the daemon stays up, ignoring its idle timeout. On Windows, a job
timeout kills the process tree immediately.

Have the daemon **run an outside program** — a bot, a watcher — as a
supervised service. Declare it, start the daemon, start the service, then read
its status:

```sh
dg-daemon service add teams-bot --cwd ~/bots/teams --env-file ~/.config/teams-bot.env \
  --pass-env TEAMS_TENANT --stop-timeout 30s --grant teams -- bun run bot.ts
```

```text
added service "teams-bot"
next: dg-daemon start, then dg-daemon service start teams-bot
```

`service add` takes the label first, then `--cwd <path>` (required) and the
command after a bare `--`. It resolves the executable to an absolute path and
writes this entry to the config file. It works with no daemon running:

```json
{
  "services": {
    "teams-bot": {
      "argv": ["/home/me/.bun/bin/bun", "run", "bot.ts"],
      "cwd": "/home/me/bots/teams",
      "envFile": "/home/me/.config/teams-bot.env",
      "passEnv": ["TEAMS_TENANT"],
      "stopTimeoutMs": 30000,
      "grant": "teams"
    }
  }
}
```

| Option | Key | Meaning |
| --- | --- | --- |
| `--cwd <path>` | `cwd` | Working directory. Required. |
| `--autostart` | `autostart` | Start the service when the daemon boots. |
| `--env-file <path>` | `envFile` | A file of `KEY=VALUE` lines. It must not be readable by other users. |
| `--pass-env <NAME>` | `passEnv` | Pass one environment variable through. Repeat the option for more. |
| `--stop-timeout <duration>` | `stopTimeoutMs` | Grace period on stop, such as `30s`. |
| `--grant <prefix>` | `grant` | Credential grant prefix. See [Service API v1](service-api.md). |

`service rm <label>` removes the entry. It refuses while the service is running
or in backoff: run `dg-daemon service stop <label>` first. It also refuses when
the daemon pid runs but does not answer, because it cannot check the state of
the service. You can also edit
the file by hand. Only a script declared there can start, and `argv` runs with
no shell.

Then start the daemon, start the service, and check it:

```sh
dg-daemon start
dg-daemon service start teams-bot
dg-daemon service status --json
```

`dg-daemon start` is idempotent: it starts the daemon in the background, or
reports the one that runs. `dg-daemon service start <label>` is not necessary
for an `--autostart` service when the daemon boots after the add. `service
add --autostart` does not start the daemon: an `--autostart` service starts
only when the daemon boots. `service status` prints one line for each service,
or one JSON line with `--json`. Stop one service with
`dg-daemon service stop teams-bot`.

### Environment

The child gets, in this order: the allowlist (`PATH`, `HOME`, `LANG`, `TZ`),
the `passEnv` names, the `envFile` lines and the injected `DG_*` keys. Each
later source overrides an earlier one, so the injected keys win. The `passEnv`
values come from the environment of the process that started the daemon. A name
that is absent from that environment logs a warning at each launch.

The daemon injects `DG_SERVICE_API`, `DG_SERVICE_LABEL` and `DG_DAEMON_URL`.
With `grant` it also injects `DG_CREDENTIAL_GRANT_PREFIX` and
`DG_CREDENTIAL_GRANT_FILE`, the path of the token file. The environment never
holds the token. See [Service API v1](service-api.md) for the route that uses
them.

### Keys

- `argv`, `cwd`, `envFile` and `autostart` are as above. `cwd` and `envFile`
  must be absolute paths.
- `passEnv` is a list of environment variable names.
- `stopTimeoutMs` is the grace period on stop, in milliseconds. The default is
  5000 and the maximum is 240000.
- `grant` is a credential grant prefix.

A daemon that ran before the upgrade reports `passEnv`, `stopTimeoutMs` and
`grant` as `unknown key(s)` until `dg-daemon restart` runs.

### Where dg keeps the files

The paths follow the per-OS layout. `<state>` and `<log>` are the State and
Logs roots of the [layout table](install.md#where-dg-keeps-its-files), which
also gives the macOS and Windows roots.

| File | Path | Linux default |
| --- | --- | --- |
| Config | `<state>/daemon/config.json` | `~/.local/state/dg/daemon/config.json` |
| Log | `<log>/service-<label>.log` | `~/.local/state/dg/log/service-<label>.log` |
| Pid file | `<state>/daemon/services/<label>.pid` | `~/.local/state/dg/daemon/services/<label>.pid` |

### Run, stop and restart

A crash restarts the script after 1s, doubling to a 60s cap; a clean exit does
not restart it. Output streams to the log file. One instance runs per label,
guarded by the pid file. On POSIX, a stop signals the whole process group. On
Windows, a service stop and a job timeout kill the process tree immediately.

Nothing starts the daemon at login. Run `dg-daemon start`, or `dg-agent start`
in an agent session. The daemon exits at its idle timeout only with no active session, no open connection, no enabled job and no running service.

`dg-daemon stop` sends SIGTERM and waits for the daemon. A regular stop waits
for the `stopTimeoutMs` of each service, 240 s at most. `dg-daemon stop
--force` kills the daemon and each service process tree immediately. It
does not kill a job command or a dispatch command that runs at that time. On
Windows, each stop of the daemon is a forced stop.

`--force` lists the services with `GET /services`. The answer carries the
`instanceId` of the daemon. The command compares it with the pid file and uses
no service pid from an answer of another instance. A daemon from before this
change sends no `instanceId`; the command then trusts the `/healthz` check it
made just before. It also ignores a pid that is not an integer above 1. On
Windows, `--force` ends the daemon process alone and then each service process
tree, so a job or dispatch command keeps running. If `/services` gives no answer
within 3 s, `--force` still kills the daemon and reports the list failure.

If the pid in the pid file still runs but `/healthz` does not answer (a hung or
stopped daemon), `dg-daemon stop` keeps the pid file and exits 1 with
`does not answer`. `dg-daemon stop --force` then kills that pid only if it is the
`dg-daemon serve` process that wrote the pid file: its command line names
`dg-daemon serve` and it started no later than the pid file. This check works
on Linux and macOS; on Windows, and for a process it cannot identify, it kills
nothing. It cannot list the services, so it exits 1 and says that a service
process can still run.

`dg-daemon restart` stops the daemon, which ends each session, then starts it
again. The restart starts only the `autostart` services, and it prints
`started on` or `already running on` with the port. The new daemon has the environment of the
caller, which is the source of the `passEnv` values. Run `dg-daemon restart`
after an upgrade so that the running daemon reads the new keys. `restart` takes
`--force` too.

With no daemon, a command that needs one fails with `no live dg-daemon`.
`job list`, `service add` and `service rm` need none.

No page lists jobs or the feed. Manage jobs with `dg-daemon job list`,
`dg-daemon job run <label>` (or `dg-daemon job exec <label>`), `dg-daemon job enable <label>`,
`dg-daemon job disable <label>` and `dg-daemon job rm <label>`. A job started with
`--notify <identity>` queues one agent message for each new feed item.

See [Service API v1](service-api.md) for how a service reads its credentials,
the [developer guide](DEVELOPER.md) for the daemon’s configuration and
[the architecture records](adr/toc.md) for process and storage decisions.
