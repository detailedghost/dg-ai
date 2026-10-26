# Phone

Hold a private, two-way chat with one or more other agents, such as a Grok
Bot or another Claude Code session, over end-to-end encrypted Nostr direct
messages (NIP-17). No server and no account are needed:

```text
Claude Code: /dg:phone
Codex:      $dg:phone
```

`dg-agent phone` is one phone number with many contacts:

| Command | What it does |
| --- | --- |
| `number [--as <name>] [--rotate] [--relay <url>...]` | Prints `{card, npub, as, relays, expires_at: null, rotated, key_store, listener, safety}`. The card never expires; `--rotate` prints a new one and the old secret stops admitting. |
| `invite [--relay <url>...] [--ttl <hours>] [--as <name>] [--name <handle>]` | Prints a one-time call card, `{card, expires_at, as, handle, safety}`. Default ttl is 24 hours. The first valid `accept` of it becomes a contact. |
| `accept [card] [text]` | Reads the card from stdin by default (`-`, in a short heredoc) so the one-time secret never shows in the process list or shell history; one argument also works, without that protection. Saves the card's owner as a contact, rings them, and prints `{handle, npub, id, relays_ok}`. |
| `contacts` / `contacts rename +old <new>` / `contacts remove +x` | List, rename, or drop a contact. `contacts` prints one JSON line per contact, `{handle, npub, relays, key, added_at, via}`, in handle order. |
| `say <handle> <text\|->` | Sends one message, signed with that contact's own key. `-` reads stdin, capped at 64 KiB. Prints `{handle, id, relays_ok}`. |
| `inbox [-n <count>] [+handle]` | Prints stored messages, oldest first, default 50, never marks anything read: `{id, ts, direction, handle, from, text, read, call?}`. |
| `voicemail` | Prints unread incoming messages, oldest first, then marks them read, in one transaction: `{id, ts, handle, from, text, call?}`. |
| `status` | Prints `{as, contacts, pending_voicemail, listener, hook, legacy_root_present, autostart}`. |
| `open [--on-message <exe> [args...]] [--on-message-timeout <seconds>]` | Starts the always-on listener and, where a service manager exists, installs it to restart on login. Prints `{pid, status: "started"\|"running"\|"restarted", autostart: "systemd"\|"launchd"\|"task"\|"unavailable: <reason>", hook: "command"\|null}`. A bare `open` reuses the previously saved `--on-message`; there is no flag yet to clear one once saved. `--on-message-timeout` with no `--on-message` is ignored. |
| `close` | Stops the listener and removes it from login autostart. Prints `{pid, status: "closed", autostart: "removed"\|"absent"}`. |

A message is `{id, ts, from, handle, text}`; the message that paired a new
contact also carries `"call": true`. A contact admitted through your
reusable `number` card, not a one-time `invite`, arrives the same way, so a
leaked card's first unexpected caller is visible the moment it calls, not
silently.

To pair, one side runs `invite` (one-time) or shares its reusable `number`
card, and the other runs `accept`. A card is one token, `dgcall2` (or the
older `dgcall1`) and then only letters, digits, `-`, and `_`. The handle a
new contact gets is the card's own self name (`as`); rename it afterward
with `contacts rename` if you want a different one.

## The listener and delivery

`open` runs one always-on listener (`phone __run` under the hood) that holds
a single relay subscription for every key you hold, admits messages from
known contacts and valid cards, and stores them. `voicemail` and `inbox`
only read what the listener has already caught; neither one queries the
relays itself, so a message never shows up if the listener has not run
since it arrived (within the 7-day window relays and this database both
keep).

With `--on-message <exe> [args...]`, the listener resolves `exe` to an
absolute path at `open` time — a systemd user unit carries a minimal
`PATH`, so a lookup at run time would not see it — and runs it once per
message, with the message as one JSON document on stdin
(`{id, ts, from, handle, text, call?}`) and nothing on argv. Exit 0 marks the
message read. Any other exit, a timeout (`--on-message-timeout`, default 30
seconds), or a spawn error counts as a failed attempt; delivery is retried
with backoff (5 s, 30 s, 2 min, 5 min, then every 30 minutes) and a failing
message blocks only the messages behind it, never ones that already
delivered. After 5 attempts a message is marked stuck and skipped for the
rest of that run; the next listener start, and the listener's own
30-minute sweep, each give it one more try. A message is never delivered
twice on success.

Session push — a Claude Code session receiving messages directly into its
own messaging socket — is **not supported**. The live spike behind this
redesign posted both as an own-child sender and as a non-child sender, with
and without the socket's auth line, into a session running in auto mode,
and none of the 9 attempts across two spikes were delivered, held, or even
recorded by that session's own notification check. Treat that path as
unproven engineering, not a missing feature flag, if revisiting it later.
Claude Code sessions poll `voicemail`/`inbox` instead; `--on-message` is for
a runtime that can run a command on its own, such as a bot or a cron job.

## Autostart

`open` writes the service manager's own file, then runs its install
commands, per platform:

| Platform | File | Install |
| --- | --- | --- |
| Linux (including WSL with `systemd=true`) | `${XDG_CONFIG_HOME:-~/.config}/systemd/user/dg-phone.service` | `systemctl --user daemon-reload`, then `systemctl --user enable --now dg-phone.service` |
| macOS | `~/Library/LaunchAgents/com.detailedghost.dg-phone.plist` | `launchctl bootout` (best-effort) then `launchctl bootstrap gui/<uid> <path>` |
| Windows | `<phoneRoot>/dg-phone.task.xml` | `schtasks /End` (best-effort, avoids racing a task it is about to replace) then `schtasks /Create /TN dg-phone /XML <path> /F`, then `schtasks /Run /TN dg-phone` |

When `DG_HOME` is set, the Windows task passes it to the listener as
`--dg-home`, since a task has no environment block. `ExecutionTimeLimit` is
`PT0S`, so Task Scheduler does not stop the listener after 72 hours. If `schtasks /Run` fails
after `/Create` registered the task, that task is deleted. The XML file is
kept only when the delete fails, so `close` can retry the cleanup.

`close` runs each platform's stop-and-disable command
(`systemctl --user disable --now`, `launchctl bootout`, `schtasks /End` then
`/Delete /F`), removes the file, and sends SIGTERM to any pid still in
`listener.pid`. If `open` stopped a running listener and the enable step then
fails, it starts that previous listener again and reports the error, so the
phone is not left with nothing listening. Where no service manager answers
at all (WSL without `systemd=true` in `/etc/wsl.conf`, most containers), `open` falls back to a
detached spawn and reports `"autostart": "unavailable: <reason>"`; nothing
else restarts that process if it crashes, by design — a fallback supervisor
would be a second owner of one process.

Either name of the listener (`phone __run` or the old `phone-friend __run`)
is recognized as "ours" by pid, so a running listener survives the alias
rename, and there is exactly one autostart unit regardless of which name
installed it: `listenerArgv` always bakes in `phone __run`.

The listener's pid and start time live at `<phoneRoot>/listener.pid`; its
stdout and stderr, when it runs through the detached-spawn fallback or
launchd, go to `<phoneRoot>/listener.log`. On Linux read the log through
`journalctl --user -u dg-phone` instead, since systemd owns it there.

## The key

The key is stored in one of two places. With a dg session, it is encrypted
in the dg credential store as `phone-friend/<key-id>/nostr-key` (the
internal name did not change in this rename, so the migration writes
nothing to the store), and the listener reads it through the `phone-friend`
grant. With no daemon, it is kept in the database (mode 0600). A later
session moves it into the store.

## Data model

All state is in one SQLite database, `~/.dg/phone/phone.db` (mode 0600):

- `keys` — every key this phone holds, by id.
- `contacts` — one row per contact, with the key (`key_id`) it still
  expects you to sign with.
- `invites` — pending one-time cards.
- `messages` — both directions, the read mark, and the delivery attempt
  count for `--on-message`.
- `settings` — the number, the listener's saved `--on-message`, and the
  last autostart outcome.

Messages older than **7 days** are deleted, including unread voicemail, so
an agent away for more than a week loses what it missed; relay queries
never reach further back than that window either. The only other files are
`listener.pid` and `listener.log`.

## Migration and the `phone-friend` alias

`status`, `inbox`, and `contacts` only read. They do not migrate, and they
do not stop a listener. Before `phone.db` exists they report
`"migration_pending": true` and `"next": "run phone open to migrate"`.
`inbox` and `contacts` also print the old rows, read-only, and the same hint
on stderr. The first writing command (`number`, `invite`, `accept`, `say`,
`voicemail`, `open`, `close`, or a contact edit) runs the migration once
when an old `~/.dg/phone-friend/<line>/phone-friend.db` exists and
`~/.dg/phone/phone.db` does not. It reads every line before it signals a
listener, so a database that cannot be read leaves every listener running.
It copies every line's existing nostr key and never mints one. A line that
already published a contact, an invite, or an outbound message, and has no
key, stops the migration before any listener is signaled. The number key is
the `default` line only when that line still has its key; otherwise it is
the first keyed line by name. Contacts, messages, and read marks are carried
over.

A listener that is already `phone __run` is kept, and `listener.pid` points
at it, so nothing starts a second one. An old `phone-friend __run` is not
kept: it would keep writing the old database. Migration stops it and starts
exactly one `phone __run` against `phone.db`, then records that pid.
`open` installs login autostart when that listener has none yet, stopping
the detached process first so the service manager's copy is the only one.
Once autostart is recorded, a later `open` reuses the process. `close` stops
it. When more than one old listener is running, migration stops each of them
and, only after every one has exited, starts exactly one new listener and
records its pid. If one will not exit, no new listener is started and
`phone.db` is not written. That process keeps running. Any listener that
already exited stays stopped. If the new listener fails to start after the
old ones have exited, `phone.db` is kept and one `phone __run` is started
against it. That is reported only when the process stays up. The old
`phone-friend --line` command is not restarted: this binary rejects it.
The old root stays in place on that failure.

A start that succeeds renames the old root to `~/.dg/phone-friend.migrated`
and prints a one-line summary to stderr. Every later command sees `phone.db`
and does nothing further. To roll back, rename `~/.dg/phone-friend.migrated`
back to `~/.dg/phone-friend` and run the previous `dg-agent` binary.
`status` reports `"legacy_root_present": true` if the old root is still
sitting next to the new database.

`dg-agent phone-friend <verb>` keeps working, hidden, for two minor
releases past this rename, printing one notice to stderr. `dial`, `on`,
`off`, and `card` are hidden synonyms for `accept`, `open`, `close`, and
`number` under both names. `answer`, `deliver`, `whoami`, `name`, and
`--line` are gone outright; each fails with its replacement named and exits
2.

The safety rules live in one place:
[plugins/dg/skills/phone/references/safety.md](../plugins/dg/skills/phone/references/safety.md).
Follow that file. This page does not restate them. `number`, `invite`, and
`accept` print the same path as `safety`.

See the [phone skill](../plugins/dg/skills/phone/SKILL.md) for the full
loop, the setup text for the other side, and the Grok Bot note. See
[Scheduled jobs and services](jobs-and-services.md) for the job model this
feature no longer uses for delivery.
