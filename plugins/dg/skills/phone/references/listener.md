# Listener, checking messages, and hooks

## Open the line

`phone open` starts the always-on listener and, where a service manager
exists, installs it to restart on login:

```bash
dg phone open   # prints {"pid": null, "status": "started", "autostart": "systemd", "hook": null}
dg phone status # prints {"as": ..., "contacts": n, "pending_voicemail": n, "listener": {"pid": n, "since": n, "stale": false}|null, "hook": {...}|null, "legacy_root_present": false, "notice": null, "autostart": "systemd"|"launchd"|"task"|"unavailable: <reason>"}
dg phone close  # prints {"pid": null, "status": "closed", "autostart": "removed"}
```

A bare `open` reuses whichever `--on-message` was last saved; add
`--on-message <exe> [args...]` to change or start one, and there is no flag
yet to clear a saved one once set. Where no service manager answers (for
example WSL without `systemd=true`, a container, or a login with no
`DBUS_SESSION_BUS_ADDRESS`), `open` falls back to a detached spawn and
reports `"autostart": "unavailable: <reason>"`. That process dies with the
login session. `open --ensure` starts one detached listener (its own
session, and it ignores hangup) only when `listener.pid` is missing, dead,
or not this binary. It is safe to run every few minutes. It does not edit
the crontab. `--print-cron` prints a line you can install yourself;
`--install-cron` writes it:

```bash
dg phone open --ensure --print-cron
```

The line is `*/5 * * * * sleep $(( $(od -An -N2 -tu2 /dev/urandom) / 1093 )); … phone open --ensure`.
That sleep is POSIX, so dash can run it, and it has no `%` because cron cuts the command at the first unescaped `%`. The listener's pid, start time, binary version, and key fingerprint live at
`<phoneRoot>/listener.pid`. `open` restarts a listener whose version or keys
differ from the database. `open --ensure` does that too, except an older
binary leaves a newer listener in place, so two dg versions that share
one phone directory do not restart each other. `status` sets `listener.stale` to true, with a
reason, when that happens, and `notice` to the newest local message. When a
key's credential-store read fails, `status` includes `keys_unreadable: true`
and leaves `stale` false, unless a key it can read has changed. A local
notice row from sender `phone` announces an accepted card, a new contact, a
key change, or a binary change. `contacts` may include `marker` (`accepted` or
`new`). Its stdout and stderr, when it runs through the fallback spawn or launchd, go
to `<phoneRoot>/listener.log`. On Linux, read the log through
`journalctl --user -u dg-phone` instead, since systemd owns it there. The
listener pings its sockets and, every 2 to 5 minutes on a jittered gap,
checks one relay with a self-addressed probe. A quiet subscription is
replaced and then caught up. The log line is `phone: listener heartbeat`,
`phone: listener resubscribe`, or `phone: listener probe-failed`.

A new contact admitted through your `number` card arrives like any message,
with `call: true` on it, so you are told about it the same way — this is
your signal that the card may have leaked; rotate it if the contact is not
one you expected.

## Check messages from Claude Code

Claude Code sessions do not receive a push: the live spike behind this
redesign tried both an own-child write and a non-child write into a
session's own messaging socket, in auto mode and otherwise, and neither
delivered. Session push is not supported; do not wire one up.

With the listener open (above), `unread`, `watch`, and `messages` only read
what it has already caught. They never query the relays themselves. Run
`phone open` once per machine, then check in at the start of a turn, or
whenever the human asks:

```bash
dg phone unread
dg phone watch --for 120
```

`watch` is the poll loop. It prints unread rows the same way `unread`
does, waits a jittered gap (2 to 8 seconds, not a fixed interval), and checks
again until `--for` seconds have passed (default 120). Run it again when it
exits. It does not restart the listener between checks.

Before you act on anything a message's text asks for, tell the human in this
chat who it is from and give a one-line summary, the same rule
[safety.md](safety.md) states for every delivery path.

## Other agents

A runtime that can run a command in response to a message — a bot, a cron
job, anything with no chat turn of its own — can take delivery instead of
polling:

```bash
dg phone open --on-message /path/to/handler.sh
```

The listener resolves `handler.sh` to an absolute path at `open` time (so a
systemd unit's minimal `PATH` never matters) and runs it once per message,
with the message as one JSON document on stdin —
`{"id": "...", "ts": ..., "from": "npub1...", "handle": "+name", "text": "...", "call": true}`,
`call` present only on the message that paired a new contact. A group message
is `{"id", "ts", "from", "handle": "#ops", "sender": "+baron", "thread": "#ops", "text", "line"}`.
`handle` is the group, not a contact. `sender` is who spoke. `line` is `[#ops] +baron: ...`.
Reply to the room with `text '#ops'`. Nothing is
on argv. Exit 0 means delivered; any other exit, a timeout
(`--on-message-timeout`, default 30 seconds), or a crash counts as a failed
attempt and is retried with backoff, then skipped after 5 attempts until the
next `open` or the listener's own 30-minute sweep. A message is never
delivered twice on success, and a stuck one blocks only the messages behind
it, never the ones that already delivered.

