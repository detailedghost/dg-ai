# Contacts, data, and migration

## Contacts

```bash
dg phone contacts                 # one JSON line per contact, in handle order
dg phone contacts rename +old new  # prints {"handle": "+new", "renamed_from": "+old"}
dg phone contacts remove +old      # prints {"removed": "+old", "npub": "npub1..."}
```

`contacts remove` deletes the contact and the extensions it used. Its stored
messages stay until the 7-day expiry. An unknown handle exits 1. A `#group`
handle exits 1: groups have no remove verb.

## Where data lives

All state is in one SQLite database, `phone/phone.db` under the dg state
directory (`~/.local/state/dg/phone/phone.db` on Linux; `resolveDgPaths` gives
the other OSes), mode 0600:
every key, every contact, every invite, every message with its read mark,
and your saved number and listener settings. The only other files are
`listener.pid` and `listener.log` next to it. Messages are kept for
**7 days**, then deleted, including unread messages — an agent away for
more than a week loses what it missed.

Do every phone action through `dg phone`, including reads (`messages`,
`unread`, `watch`, `contacts`). Never query `phone.db` directly. See
[safety.md](safety.md).

## Migration

Every `dg phone` command except `listen` converts old phone-friend lines
first, once. A command that only reads, such as `status`, `messages`, or
`contacts`, converts too. The conversion reads every line, then copies its
existing key (never a newly minted one), contact, and message into the new
database. A conversion error fails that command. A published line with no key
stops the migration before any listener is signaled and says to restore that
line's nsec, or the credential `phone-friend/<line>/nostr-key`, then run
`phone open`. `dg install` prints that failure as a warning.
`phone listen` never converts. While old lines wait, it exits 1 with
`dg: phone-friend lines wait for conversion; run dg phone status`.

No command rolls the data back. The manual steps are in `docs/install.md`,
section `Roll back to a release that uses ~/.dg`.

This process's own `phone listen` is kept. Any other live listener, including a
`phone listen` that is not this process, is restarted so it reloads keys. An old `phone-friend`
listener is stopped and exactly one new listener is started against
`phone.db`, and its pid is recorded. `open` installs login autostart when
none is recorded yet, stopping that detached process first so only the
service manager's copy keeps running. `close` stops it. More than one old
listener is stopped, and exactly one new listener starts only after each of
them has exited. If one will not exit, nothing new is started and `phone.db`
is not written. That process keeps running, and any listener that already
exited stays stopped. If the new listener fails to start, `phone.db` is kept
and one `phone listen` is started against it, reported only if that process
stays up. The old per-line listener command is not restarted. The old
root stays in place on that failure
and is renamed to `phone-friend.migrated` in the same state folder only after a
start that succeeded. Every later command is a no-op migration check.
`phone status` reports `"legacy_root_present": true` if the old root
is still in place alongside the new database.

