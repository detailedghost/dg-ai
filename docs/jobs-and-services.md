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
queues one agent message when a run brings in something new. `job list`, `job run`, `job enable`, `job disable` and `job rm` manage them from there.

`dg-agent phone-friend deliver on` registers one of these jobs per line. Its
stored argv is `dg-agent phone-friend voicemail` (plus `--line <name>` for any
line other than `default`), and `--notify` is the agent identity that should
hear about unread messages. See [Phone friend](phone-friend.md).

A job inherits no secrets: the daemon passes only `PATH`, `HOME`, `LANG` and
`TZ` to the child, so the command must authenticate through its own config
under `HOME` (`~/.sentryclirc`, `~/.config/jira`, and so on). While any job is
enabled the daemon stays up, ignoring its idle timeout.

Have the daemon **keep a long-running script alive** — a bot, a watcher —
by declaring it under `services` in `~/.dg/daemon/config.json`:

```json
{
  "services": {
    "teams-bot": {
      "argv": ["bun", "run", "bot.ts"],
      "cwd": "/home/me/bots/teams",
      "envFile": "/home/me/.config/teams-bot.env",
      "autostart": true
    }
  }
}
```

Only a script declared there can start, and `argv` runs with no shell. `cwd`
and `envFile` must be absolute paths. The child gets `PATH`, `HOME`, `LANG` and
`TZ`, plus the `KEY=VALUE` lines of `envFile`, which must not be readable by
other users. Then drive it against the live daemon:

```sh
dg-daemon service start teams-bot
dg-daemon service status
dg-daemon service stop teams-bot
```

A crash restarts the script after 1s, doubling to a 60s cap; a clean exit does
not restart it. Output streams to `~/.dg/daemon/logs/service-<label>.log`. One
instance runs per label, guarded by `~/.dg/daemon/services/<label>.pid`. Stop
signals the whole process group. A running service keeps the daemon from its
idle exit. Nothing starts the daemon at login yet, so `autostart` only applies
once the daemon is running.

The extension's **dashboard page** shows what has come in — jobs and their next
run on the left, the feed on the right — and hands any item to an agent. Jobs
are added by CLI for now; a page for that is the next step.

See the [developer guide](DEVELOPER.md) for the daemon’s configuration and
[the architecture records](adr/toc.md) for process and storage decisions.
