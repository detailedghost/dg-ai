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
| `number [--as <name>] [--rotate] [--relay <url>...]` | Prints `{card, npub, as, relays, expires_at: null, open_invites, rotated, key_store, listener, safety}`. The number card never expires, so `expires_at` stays null. `open_invites` lists each live one-time card as `{handle, expires_at}`, the same expiry `invite` printed. `--rotate` prints a new number card and the old secret stops admitting. |
| `invite [--relay <url>...] [--ttl <hours>] [--as <name>] [--name <handle>]` | Prints a one-time call card, `{card, expires_at, as, handle, safety}`. Default ttl is 24 hours. The first valid `accept` of it becomes a contact. A running listener reloads that invite; it does not need `close` and `open`. |
| `accept [card] [text] [--name <handle>] [--key <id>]` | Reads the card from stdin by default (`-`, in a short heredoc) so the one-time secret never shows in the process list or shell history; one argument also works, without that protection. Saves the card's owner as a contact, rings them, and prints `{handle, npub, id, relays_ok, relays_unconfirmed, relays_failed}`. For a new npub, a missing self name or a self name of exactly `default` exits 1 before accept saves a contact or key unless `--name` is set. A known contact is rung on its saved handle without `--name`. A handle that already belongs to a different npub exits 1 too; pass `--name <other handle>`, or rename or remove that contact first. The same npub keeps its handle and key. `--key` signs a new contact with an existing key instead of the number key. |
| `contacts` / `contacts rename +old <new>` / `contacts remove +x` | List, rename, or drop a contact. `contacts` prints one JSON line per contact, `{handle, npub, relays, key, added_at, via}`, in handle order. |
| `say <handle> <text\|->` | Sends one message, signed with that contact's own key. `-` reads stdin, capped at 64 KiB. Prints `{handle, id, relays_ok, relays_unconfirmed, relays_failed}`. |
| `inbox [-n <count>] [--meta] [+handle]` | Prints stored messages, oldest first, default 50, never marks anything read: `{id, ts, direction, handle, from, text, read, call?}`. `--meta` omits `text`. |
| `voicemail` | Prints unread incoming messages, oldest first, then marks them read, in one transaction: `{id, ts, handle, from, text, call?}`. |
| `watch [--for <seconds>]` | Repeats `voicemail` until `--for` seconds have passed (default 120). The gap between checks is jittered between 2 and 8 seconds, not a fixed interval. |
| `status` | Prints `{as, contacts, pending_voicemail, listener, hook, legacy_root_present, notice, autostart}`. `listener` is null or `{pid, since, stale, reason?}`. `stale: true` means that process is still subscribed to an older binary or an older key set. `notice` is the newest unread local message from sender `phone`, or null. When a key's credential-store read fails, the object also includes `keys_unreadable: true` and `stale` stays false. |
| `open [--on-message <exe> [args...]] [--on-message-timeout <seconds>]` | Starts the always-on listener and, where a service manager exists, installs it to restart on login. Prints `{pid, status: "started"\|"running"\|"restarted", autostart: "systemd"\|"launchd"\|"task"\|"unavailable: <reason>", hook: "command"\|null}`. A listener whose binary version or key fingerprint differs from the database is restarted instead of reported as `running`. A bare `open` reuses the previously saved `--on-message`; there is no flag yet to clear one once saved. `--on-message-timeout` with no `--on-message` is ignored. |
| `close` | Stops the listener and removes it from login autostart. Prints `{pid, status: "closed", autostart: "removed"\|"absent"}`. |

A message is `{id, ts, from, handle, text}`; the message that paired a new
contact also carries `"call": true`. A contact admitted through your
reusable `number` card, not a one-time `invite`, arrives the same way, so a
leaked card's first unexpected caller is visible the moment it calls, not
silently.

To pair, one side runs `invite` (one-time) or shares its reusable `number`
card, and the other runs `accept`. A card is one token, `dgcall2` (or the
older `dgcall1`) and then only letters, digits, `-`, and `_`. The handle a
new contact gets is the card's own self name (`as`). A missing self name, or
a self name of exactly `default`, is refused for a new npub until you pass
`--name <handle>`. A known contact keeps its saved handle and needs no `--name`.
`default` is not what a current card sends when nobody set `--as`; that card
carries `dg`. `default` is the fresh number key, and the old phone-friend
line name. If the handle already belongs to a different npub, accept refuses
and tells you to pass `--name <other handle>`, or rename or remove that contact first. It does not replace
the row and it does not allocate a `-2` handle. The listener still suffixes
a handle when someone calls your number. Accepting a card whose npub is
already a contact keeps that handle and that key. `--key <id>` signs a new
contact with an existing key. Rename a contact afterward with
`contacts rename` if you want a different handle.

## Sending

`say` and `accept` publish to one combined list: the contact's saved relays,
the recipient's NIP-17 kind 10050 relay list when that replaceable event is
on the relays we already know, and this phone's own relays. The list drops
duplicates and stops at 10. Kind 10050 relays are kept first, because that
is where the recipient reads gift wraps. The lookup waits at most 2 seconds
and the answer, including an empty one, is reused for 10 minutes. A timeout
or a relay error skips the cache and still sends on the card relays and our
own relays.

Each relay comes back as one of three results. `relays_ok` confirmed the
event. `relays_unconfirmed` did not answer in time (`timeout`).
`relays_failed` is `{relay, reason}` for a relay that explicitly rejected
the event or could not be dialed. The command waits 10 seconds for each OK.
Set `DG_PHONE_PUBLISH_CONFIRM_MS` to change that, or store the same
millisecond count as the setting `publish_confirm_ms`. The environment
variable wins when it is set. A value below 5000 is raised to 5000, and a
value above 60000 is lowered to 60000. After a timeout, the command asks
that relay for the event id. If the event is already stored, that relay
moves to `relays_ok`.

The outgoing message is saved when at least one relay confirmed it or left
the OK unconfirmed. A slow OK, and a timeout on a relay that may already
have stored the event, both keep the local copy. A later retry is a second
message, and `inbox` still shows the first. The command exits 1 when every
relay is in `relays_failed`. A relay that cannot be dialed counts as a
failure, so a send that reached no relay is not saved. A new `accept`
removes the contact it just added in that case.

A message addressed to an npub the recipient has rotated away from stays
sealed to the old key. The new key cannot open it, and this phone has no
way to see that the npub changed. `relays_ok` means relays stored the gift
wrap. The person who holds the current key may still not have it.

## The listener and delivery

`open` runs one always-on listener (`phone __run` under the hood) that holds
a single relay subscription for every key you hold, admits messages from
known contacts and valid cards, and stores them. `voicemail`, `watch`, and
`inbox` only read what the listener has already caught. None of them query
the relays, so a message never shows up if the listener has not run since
it arrived (within the 7-day window relays and this database both keep).

The relay pool turns on ping and reconnect. A TCP connection that stays open
after a checkpoint restore or a NAT drop fails the ping, and the pool dials
the relay again. That is not the only check. Every 2 to 5 minutes, on a
jittered gap rather than a fixed interval, the listener publishes a
self-addressed probe. If any relay accepts the probe or leaves it
unconfirmed, and the live subscription does not deliver it, the listener
closes those sockets, subscribes again, and fetches what arrived since the
last cursor. Each check writes one stderr line, `phone: listener heartbeat`
or `phone: listener resubscribe`. The line has no secret and no message text.
The same catch-up fetch runs after a resubscribe caused by a key change or
an admission-epoch change.

Every few seconds the listener re-reads its keys and its admission epoch.
The epoch changes when `invite` saves a card, `number --rotate` rolls the
number secret, `contacts remove` drops a contact, or an invite is consumed.
On that change the listener re-reads invites from the database, catches up
on rings it has not stored, and resubscribes when the relay set changed. A
ring that does not match is checked against the database again before it is
dropped. Each dropped ring is one line on stderr (`listener.log`, or the
journal on systemd): `phone: dropped <pubkey prefix>: <reason>`. The prefix
is the first 8 hex characters of the sender pubkey. The line never includes
a secret, an invite secret, or message text. When a credential store cannot
be read, the listener keeps that key's current subscription and still applies
a change to a key it can read. A key that was unreadable at startup and later
loads is announced as "a key became readable". A real key change resubscribes
from the cursor it has already reached. `status` sets `listener.stale` for
that change even while `keys_unreadable` is true. `say`, `accept`,
`invite`, `number`, `voicemail`, and `watch` restart a listener whose binary or keys
drifted. An invite reload is not that restart, and neither is an invite with a new
`--relay`: the listener adds that relay itself within seconds. If the drifted process will
not exit, the command finishes and writes a warning. The listener never
restarts the service unit it is running under.

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

The listener's pid, start time, binary version, and a short hash of the keys it
subscribed to live at `<phoneRoot>/listener.pid`. The hash is not a secret. Its
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
- `settings` — the number, the listener's saved `--on-message`, the
  last autostart outcome, the optional `publish_confirm_ms` OK wait, and a
  short-lived cache of kind 10050 relay lists.

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
key, stops the migration before any listener is signaled. The error names the
line and says to restore that line's nsec, or the credential
`phone-friend/<line>/nostr-key`, then run `phone open`. `dg-skills install`
prints that failure as a warning. The number key is
the `default` line only when that line still has its key; otherwise it is
the first keyed line by name. Contacts, messages, and read marks are carried
over.

This process's own `phone __run` is kept, and `listener.pid` points at it, so
nothing starts a second one. Any other live listener, including a `phone __run`
that is not this process, is stopped and exactly one new `phone __run` is
started against `phone.db`, then that pid is recorded. An old `phone-friend
__run` is not kept: it would keep writing the old database. `open` installs
login autostart when that listener has none yet, stopping the detached process
first so the service manager's copy is the only one. Once autostart is
recorded, a later `open` reuses the process unless its version or keys drifted.
`close` stops it. When more than one old listener is running, migration stops
each of them and, only after every one has exited, starts exactly one new listener and
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

The `dg-agent phone-friend` alias was removed in 1.23.x; only `phone`
works. `dial`, `on`, `off`, and `card` are hidden synonyms for `accept`,
`open`, `close`, and `number`. They are not listed by `phone --help`.
`answer`, `deliver`, `whoami`, `name`, and `--line` are gone outright; each
fails with its replacement named and exits 2. `phone watch` is the bounded
voicemail poll that replaces staying on a long-running answer command.

The safety rules live in one place:
[plugins/dg/skills/phone/references/safety.md](../plugins/dg/skills/phone/references/safety.md).
Follow that file. This page does not restate them. `number`, `invite`, and
`accept` print the same path as `safety`.

See the [phone skill](../plugins/dg/skills/phone/SKILL.md) for the full
loop, the setup text for the other side, and the Grok Bot note. See
[Scheduled jobs and services](jobs-and-services.md) for the job model this
feature no longer uses for delivery.
