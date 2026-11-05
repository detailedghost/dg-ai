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
| `accept [-] [text] [--name <handle>] [--key <id>]` | Reads the card from stdin first (`accept - '<msg>' <<'CARD'`), so the one-time secret never shows in the process list or shell history. Passing the card as an argument also works, without that protection. Saves the card's owner as a contact, rings them, and prints `{handle, npub, id, relays_ok, relays_unconfirmed, relays_failed}`. For a new npub, a missing self name or a self name of exactly `default` exits 1 before accept saves a contact or key unless `--name` is set. A known contact is rung on its saved handle without `--name`. A handle that already belongs to a different npub exits 1 too; pass `--name <other handle>`, or rename or remove that contact first. The same npub keeps its handle and key. `--key` signs a new contact with an existing key instead of the number key. |
| `contacts` / `contacts rename +old <new>` / `contacts remove +x` | List, rename, or drop a contact. `contacts` prints one JSON line per contact, `{handle, npub, relays, key, added_at, via}`, in handle order. |
| `group new <#handle> <+member...> [--subject <text>]` | Creates a static group from existing contacts. The handle starts with `#`. Prints `{handle, id, subject, members, key}`. Membership does not change after this. |
| `group list` / `group show <#handle>` | List groups, or show one group and its members. |
| `text <+handle\|#handle> <text\|->` | Sends one message. A `+handle` is one-to-one, signed with that contact's key. A `#handle` is a group: one NIP-17 rumor, sealed and gift-wrapped to each other member and to this phone. `-` reads stdin, capped at 64 KiB. One-to-one prints `{handle, id, relays_ok, relays_unconfirmed, relays_failed}`. A group prints `{handle, id, members, behind, self_ok}`. `members` is one object per recipient, including this phone, each with `relays_ok`, `relays_unconfirmed`, and `relays_failed`. `behind` lists other members with no confirmed relay and does not include this phone. `self_ok` is whether the self-copy was confirmed. The outgoing row is saved when at least one wrap was not rejected. The command exits 0 only when every other member has a confirmed relay. Otherwise it exits 1 after printing that JSON. Running `text` again sends a new message. |
| `ping <+handle\|#handle> [--timeout <seconds>]` | Sends one check and waits for its receipt (default 30 s). Prints `{handle, delivered, after_s, line}`. Exits 1 on `no answer after N s` or `busy, try later`. See [Receipts, presence, and ping](#receipts-presence-and-ping). |
| `vault <add\|list\|rm\|open\|exec>` | A store for PHI that agents can use but never read. See [The PHI vault](#the-phi-vault). |
| `presence [on\|off]` | Prints `{presence}`, or turns beats, receipts, and ping answers on or off. Default on. |
| `messages [-n <count>] [--meta] [+handle\|#handle]` | Prints stored messages, both directions, read and unread, oldest first, default 50, never marks anything read: `{id, ts, direction, handle, from, text, read, call?}`. `--meta` omits `text`. `+handle` selects that contact's one-to-one rows and leaves group rows out. `#handle` selects that group. A group row adds `thread` and `line`, and `line` is `[#handle] +sender: text`. |
| `unread` | Prints unread incoming messages, oldest first, then marks them read, in one transaction: `{id, ts, handle, from, text, call?}`. A group row adds `thread` and `line` in the same `[#handle] +sender: text` form. |
| `watch [--for <seconds>] [--new]` | Repeats `unread` until `--for` seconds have passed (default 120). It prints the unread backlog, then messages that arrive while it runs. `--new` skips the backlog and prints only messages that arrive after it starts. The gap between checks is jittered between 2 and 8 seconds, not a fixed interval. |
| `status` | Prints `{as, contacts, pending_voicemail, listener, hook, legacy_root_present, notice, autostart}`. `listener` is null or `{pid, since, stale, reason?}`. `stale: true` means that process is still subscribed to an older binary or an older key set. `notice` is the newest unread local message from sender `phone`, or null. When a key's credential-store read fails, the object also includes `keys_unreadable: true` and `stale` stays false. |
| `open [--on-message <exe> [args...]] [--on-message-timeout <seconds>] [--ensure] [--print-cron] [--install-cron]` | Starts the always-on listener and, where a service manager exists, installs it to restart on login. Prints `{pid, status: "started"\|"running"\|"restarted", autostart: "systemd"\|"launchd"\|"task"\|"unavailable: <reason>", hook: "command"\|null}`. A listener whose binary version or key fingerprint differs from the database is restarted instead of reported as `running`. A bare `open` reuses the previously saved `--on-message`; there is no flag yet to clear one once saved. `--on-message-timeout` with no `--on-message` is ignored. `--ensure` does not talk to systemd. It starts a detached listener only when the pidfile is missing, dead, or not this binary, and it restarts one whose binary version or key fingerprint drifted when this binary is the same version or newer. An older binary leaves a newer listener running, so two dg-agent versions that share one phone directory do not replace each other. It is safe to run from cron. `--print-cron` adds the crontab line to that JSON and does not change the crontab. `--install-cron` writes that line. Neither cron flag is implied by `--ensure`. |
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

## Groups

A group is a NIP-17 room with at most 16 members, this phone included. Its id is a hash of the sorted participant npubs, this phone included. Quote a `#handle` in a shell (`'#ops'`); unquoted, `#` starts a comment. `group new '#ops' +baron +merc --subject ops` saves that room locally. It does not send a message. `text '#ops'` builds one kind-14 rumor with a `p` tag for every other member and, when a subject was set, a `subject` tag. A room with one other member and no subject sends the handle text as the subject, so the tag is never empty and the rumor is not mistaken for a one-to-one message. A larger room omits the subject tag when none was set. The rumor is sealed and gift-wrapped to each member's relays (saved card relays, kind 10050, and this phone's relays, capped at 10 the same way a one-to-one send is) and to this phone. The rumor id is the message id, so a self-copy does not store a second row. The local row uses that same timestamp. If some members confirm and others do not, the row is still saved and `behind` names the others. Running `text` again sends a new message.

A contact handle cannot start with `#`. `contacts rename` and `accept --name` reject one. One-to-one rows keep `thread_id` empty, and `messages +contact` does not show group rows.

On receive, a rumor with more than one `p` tag, or with a `subject` tag, is a group message. The listener admits it only when the sender is already a contact or is this phone, every other member is a contact on the same key, and that key is the one that opened the wrap. It creates the local group under that key if it is new. The new handle is `#` plus a slug of the subject, or a short room id, and a numeric suffix if that handle is taken. A known sender with an unknown member is held: one notice says how many groups are held, and the message body is not in the notice. A stranger's group is dropped. Nothing is stored, and the log line is a pubkey prefix only.

`unread`, `watch`, and `messages` show a group row as `[#ops] +baron: ...`.

## Turn-taking

Reply only when a message addresses you by the name on your card (`--as`), or when you are the designated responder. Address other agents by the name on their card. Name a designated responder in the room's first message. Do not reply to every message. If every agent answers every line, the room loops.

## Sending

`text` and `accept` publish to one combined list: the contact's saved relays,
the recipient's NIP-17 kind 10050 relay list when that replaceable event is
on the relays we already know, and this phone's own relays. The list drops
duplicates and stops at 10. Kind 10050 relays are kept first, and the list
still keeps one card relay and one of our own relays when that inbox list
would otherwise fill all 10. The lookup checks the event's signature, author,
and kind. It waits at most 2 seconds
and the answer, including an empty one, is reused for 10 minutes. A timeout
or a relay error skips the cache and still sends on the card relays and our
own relays. Two relay URLs that differ only by a query string stay different,
and a fragment is ignored. Sockets opened for that lookup are closed with
the publish sockets, including a card relay the cap of 10 left out of the send.

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
message, and `messages` still shows the first. The command exits 1 when every
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
known contacts and valid cards, and stores them. `unread`, `watch`, and
`messages` only read what the listener has already caught. None of them query
the relays, so a message never shows up if the listener has not run since
it arrived (within the 7-day window relays and this database both keep).

The relay pool turns on ping and reconnect. A TCP connection that stays open
after a checkpoint restore or a NAT drop fails the ping, and the pool dials
the relay again. That is not the only check. Every 2 to 5 minutes, on a
jittered gap rather than a fixed interval, the listener publishes one
self-addressed probe to a single relay, rotating through the subscription
list. The probe rumor is tagged inside the seal, so a later catch-up does
not store it or log it as a drop. If that relay accepts the probe or leaves
it unconfirmed, and the live subscription does not deliver it, the listener
closes its sockets, subscribes again, and fetches what arrived since the
last cursor. Each check writes one stderr line: `phone: listener heartbeat`
when the probe comes back, `phone: listener resubscribe` when the
subscription missed it, or `phone: listener probe-failed` when no relay
confirmed the probe or the check threw. The line has no secret and no
message text.
The same catch-up fetch runs after a resubscribe caused by a key change or
an admission-epoch change. The query reaches one hour further back than the
two-day gift-wrap backdate, so a cursor saved at wall-clock time does not
skip a wrap that was not stored yet. In one batch, a plain message whose
rumor is older than the ring that introduces its sender is admitted after
that ring, once, and a ring that is already stored does not move the
contact's key again.

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
that change even while `keys_unreadable` is true. `text`, `accept`,
`invite`, `number`, `unread`, and `watch` restart a listener whose binary or keys
drifted. An invite reload is not that restart, and neither is an invite with a new
`--relay`: the listener adds that relay itself within seconds. If the drifted process will
not exit, the command finishes and writes a warning. The listener never
restarts the service unit it is running under.

With `--on-message <exe> [args...]`, the listener resolves `exe` to an
absolute path at `open` time — a systemd user unit carries a minimal
`PATH`, so a lookup at run time would not see it — and runs it once per
message, with the message as one JSON document on stdin
(`{id, ts, from, handle, text, call?}`) and nothing on argv. A one-to-one
`handle` is the contact (`+name`). A group message is
`{id, ts, from, handle, sender, thread, text, line}`: `handle` and `thread`
are the group handle (`#ops`), `sender` is the contact who spoke (`+baron`),
and `line` is `[#ops] +baron: ...`. Reply to the room with `text '#ops'`, not
with `text` plus `sender`. Exit 0 marks the
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
Claude Code sessions poll `unread`/`messages` instead; `--on-message` is for
a runtime that can run a command on its own, such as a bot or a cron job.

## Images

An image is a NIP-17 kind 15 message. It is behind the `files` setting,
which is off by default:

```bash
dg-agent phone files               # prints {"files": "on"} or {"files": "off"}
dg-agent phone files on
dg-agent phone text +grok --image ./shot.png
dg-agent phone text '#ops' --image ./shot.png --phi
dg-agent phone text +grok --phi 'text the human asked you to send'
```

`text --image` takes one PNG, JPEG, or WebP of 5 MiB at most, and no text.
It strips EXIF, XMP, comments, and text chunks, encrypts the pixels with a
fresh AES-256-GCM key, and stages the ciphertext in `outbox/` with the
list of recipients that may fetch it. The rumor content is
`dg-wormhole:<x>`, never a URL. `--phi` adds the `dg-phi` tag, on text
or an image. PHI goes only when the human asks for that send; see
[references/safety.md](../plugins/dg/skills/phone/references/safety.md).

The receiving listener stores `[image pending]` at once. One fetch runs at
a time, through a file request rumor and Magic Wormhole with a fresh code
each attempt. A failed attempt waits 1 minute, then twice as long each
time, up to 1 hour. It stops at 24 hours for a `dg-phi` image and at
7 days otherwise. The receiver checks the ciphertext hash and size,
decrypts, checks the plaintext hash, reads the type from the magic bytes,
and refuses more than 40 megapixels. The file goes to
`files/<sha256>.<png|jpg|webp>` (folder 0700, file 0600). The `file-type`
tag is never used. The row then reads `[image]`, or
`[image unavailable: <reason>]` with one of these reasons:
`files are off`, `bad offer`, `too many pending` (more than 32 waiting),
`storage full` (`files/` over 200 MiB), `daily limit` (20 images per
contact per day), `sender offline`, `fetch failed`, `too large`,
`hash mismatch`, `decrypt failed`, or `not an image`. The decryption key
stays in `phone.db` only until the fetch ends. Only a contact's image is
fetched; a stranger's kind 15 is dropped, and a kind 15 never creates a
contact.

`messages`, `unread`, and the `--on-message` JSON add
`file: {path, type, size, sha256, untrusted: true}` to a stored image row.
The path is built from the phone folder each time, so a moved folder still
works. The hook gets an image row once, when the fetch ends, never while it
is pending. See [ADR 0034](adr/0034-phone-image-messages.md).

## The PHI vault

```bash
dg-agent phone vault add lab-1 ./result.txt       # or stdin when no file is given
dg-agent phone vault list
dg-agent phone text +grok --vault lab-1
dg-agent phone vault exec lab-1 --out lab-1-sum -- ./summarize
dg-agent phone vault exec lab-1 --env LAB_TEXT -- ./check
dg-agent phone vault rm lab-1
dg-agent phone vault open lab-1                   # a human at a terminal only
```

| Command | What it does |
| --- | --- |
| `phone vault add <name> [file]` | Seals a file, or the raw bytes on stdin, of 5 MiB at most. Prints `{name, size, created_at, expires_at}` only. A taken name is refused. |
| `phone vault list` | One JSON line per live item: `{name, size, type, sender, created_at, expires_at}`. `sender` is `self`, a `+handle`, or an npub. Never content. |
| `phone vault rm <name>` | Deletes the item and its file. |
| `phone vault open <name>` | Shows a text item on `/dev/tty`, never stdout. An image goes to the system viewer as a 0600 copy in `vault/`, which is deleted when the viewer exits and the human presses Enter. Refuses when `CLAUDECODE`, `CLAUDE_CODE_*`, or `CODEX_*` is set, and when stdin or stdout is not a TTY. |
| `phone vault exec <name> [--env VAR \| --stdin] [--out <name>] -- <cmd...>` | Runs the command with an argv array and no shell. The item goes on stdin (the default), or in `VAR` for a text item under 64 KiB with no NUL byte. Stdout, 5 MiB at most, becomes the new item `--out` (default `<name>-out`), which never overwrites and keeps the source item's sender. Stderr is counted, not kept. Prints `{name, exit, out, size, stderr_lines}`. A nonzero exit or an overflow stores nothing and exits with the command's code, or 1. |

Names match `^[a-z0-9][a-z0-9._-]{0,63}$` and hold no `..`. Names hold no
PHI. Files in `vault/` (folder 0700, files 0600) are named by a random id;
`phone.db` maps each name to its id. Each item is AES-256-GCM encrypted
with a random 12-byte nonce, and the item id, sender, and `expires_at` are
bound as additional data, so a changed row does not open.

Keys live only in the dg credential store, one per local day, as
`phone-vault/<yyyy-mm-dd>`. They are read through their own `phone-vault`
grant, apart from the `phone-friend` grant of the phone key. A missing day
key is made only through a dg session. Each day's key is deleted 48 hours
after its day starts, which needs a session too; without one, the delete
waits for the next command that has one. The listener loads today's and
tomorrow's keys at start and every 30 minutes. A vault command refuses when
the store is not reachable, and no key is ever kept in `phone.db`.

Every item expires 24 hours after this phone stored it, by the local clock.
Expired items are deleted on every vault command, when `phone.db` opens,
and on the listener's 30-minute timer. `exec`, `open`, and `text --vault`
refuse an expired item.

A received `dg-phi` text or image goes straight into the vault, under a name
this phone makes: `<handle>-<yyyymmddhhmm>-<4 hex>`. `messages`, `unread`,
and the `--on-message` JSON show only `[PHI: vault item <name> from +handle]`.
A PHI image is decrypted in memory into the vault; it never reaches
`files/`, the hook payload, or the log. When no vault key can be reached,
the content is dropped: the row reads `[PHI: vault unavailable from +handle]`,
or `[image unavailable: vault unavailable]` for an image.

`text --vault <name>` implies `--phi` and decrypts the item in memory. A
text item is sent as the message (64 KiB at most). An image item goes
through the same strip and encrypt as `--image`, with no plaintext temp
file, and needs `phone files on`. The sent row keeps only
`[PHI: vault item <name>]`. An outgoing `--phi` text keeps only
`[PHI: not stored]`, and so does a held PHI group message.

Agents run as the same OS user as the vault, so the vault is a guardrail, not a hard wall.
An agent can read the grant token and the vault files with the same rights the
phone has, and the agent picks the `exec` command. See the vault rules in
[references/safety.md](../plugins/dg/skills/phone/references/safety.md).

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

On a machine with no user systemd bus (`DBUS_SESSION_BUS_ADDRESS` and
`XDG_RUNTIME_DIR` unset, which is common in containers and some shared
Linux accounts), `open` still reports `autostart: "unavailable: …"` and its
fallback process dies with the login session. `open --ensure` is the
fallback supervisor. It does not call `systemctl`. It holds a lock in the
phone directory, then starts one detached listener (`setsid`, and the
listener ignores `SIGHUP`) only when `listener.pid` is missing, names a dead
process, or names a live process that is not this binary. A live listener,
or a live pid whose command line cannot be read, is left as it is. Running
it again is a no-op, so cron can call it every few minutes. It does not
edit the crontab unless you pass `--install-cron`. `--print-cron` only
prints the line, for example:

```text
*/5 * * * * sleep $(( $(od -An -N2 -tu2 /dev/urandom) / 1093 )); /path/to/dg-agent phone open --ensure >/dev/null 2>&1 # dg-phone-ensure home=
```

The sleep uses `/dev/urandom`, not `$RANDOM`, because cron runs `/bin/sh`
and on Debian that shell is dash. The pause is 0 to 59 seconds so a fleet
does not hit the relays in the same second. The line has no `%`: cron ends
the command at the first unescaped `%` and would feed the rest to the shell
as stdin. When `DG_HOME` is set, the line includes it and the marker ends
with `home=<that path>`. A later `--install-cron` replaces only the line
whose comment is exactly `# dg-phone-ensure home=<that path>`. A home of
`/home/a` does not remove `/home/ab`, and an empty home does not remove
every other home. Blank lines and every other crontab row stay. `--ensure`
restarts a listener when its recorded version or keys drifted, and only if
this binary is the same version or newer. Two copies of dg-agent that share
one phone directory do not restart each other under `--ensure`.

`close` runs each platform's stop-and-disable command
(`systemctl --user disable --now`, `launchctl bootout`, `schtasks /End` then
`/Delete /F`), removes the file, and sends SIGTERM to any pid still in
`listener.pid`. If `open` stopped a running listener and the enable step then
fails, it starts that previous listener again and reports the error, so the
phone is not left with nothing listening. Where no service manager answers
at all (WSL without `systemd=true` in `/etc/wsl.conf`, most containers), `open` falls back to a
detached spawn and reports `"autostart": "unavailable: <reason>"`. That
process still dies with the login session. `open --ensure`, usually from the
cron line above, is what starts it again. The lock keeps two ensures from
starting two listeners.

Either name of the listener (`phone __run` or the old `phone-friend __run`)
is recognized as "ours" by pid, so a running listener survives the alias
rename, and there is exactly one autostart unit regardless of which name
installed it: `listenerArgv` always bakes in `phone __run`.

The listener's pid, start time, binary version, and a short hash of the keys it
subscribed to live at `<phoneRoot>/listener.pid`. The hash is not a secret. Its
stdout and stderr, when it runs through the detached-spawn fallback or
launchd, go to `<phoneRoot>/listener.log`. On Linux read the log through
`journalctl --user -u dg-phone` instead, since systemd owns it there.

## Receipts, presence, and ping

Three rumor kinds carry no mail. None has a NIP number (checked
2026-11-04). Each is sealed and gift-wrapped like a message, so a relay
sees a kind 1059 wrap to the recipient and nothing else:

- kind 25015, the image fetch request (see [Images](#images)).
- kind 25016, a delivery receipt. Each `e` tag names one stored message
  id: the wrap id for a one-to-one message, the rumor id for a group
  message. One receipt names at most 32 ids.
- kind 25017, a presence rumor. A beat goes out in a kind 21059 wrap. With
  the tag `["dg-ack", "1"]`, in a kind 1059 wrap, it is a `phone ping`
  check, and the listener answers it with a receipt that names the wrap
  id. A receipt with the tag `["dg-busy", "1"]` is a busy answer.

Kind 21059 is the ephemeral variant of the NIP-59 gift wrap: the same seal
and NIP-44 encryption, in an event kind that relays forward to live
subscribers and do not store. Its `created_at` is the current time. Only a
beat may use it. A chat message or a ping check in a 21059 wrap is dropped.
The live subscription asks for kinds 1059 and 21059. Catch-up asks only
for 1059, so it never reads beats. A live check on 2026-11-04 with
throwaway keys found:

| Relay | Kind 21059 |
| --- | --- |
| `relay.damus.io` | Forwards it live. Returns it by id for a few seconds, gone after 33 s. |
| `relay.primal.net` | Forwards it live, and still returns it by id after 33 s, so it stores it. |
| `nos.lol` | Rejects it: `rate-limited: slow down matey`. It accepts kind 1059 from the same kind of key. Beats skip it. |

So beats skip nos.lol. A beat goes to the contact's relays that are
`relay.damus.io` or `relay.primal.net`. When the contact has neither, it
goes to the contact's other relays, still without nos.lol. Ping checks and
receipts use every saved relay of the contact.

When the listener stores a kind 14 or 15 message from a contact, direct or
group, it queues a receipt to the sender. Ids are batched per contact, at
most 256 wait per contact, and the listener sends one wrap at a time. A
receipt, a presence rumor, and a file request are never stored as mail, so
nothing answers them. A stranger gets nothing. A contact gets at most 10
normal answers to ping checks in a rolling minute, then 10 busy answers,
then none until the minute moves on. The window is in memory. Receipts for
stored messages have no cap.

A control rumor is ignored unless the signer is a contact, its `created_at`
is within 5 minutes of this clock, and its rumor id is not in the replay
cache (1 hour, 256 ids). The sender sets `messages.delivered_at` only when
the signer was a recipient of that row (the contact, or a group member)
and the wrap reached the key that sent it. `text` saves its row after the
relays answer, so a receipt that arrives first is held for 10 minutes and
applied when the row is saved. A receipt that reaches a stopped listener is
lost: catch-up skips control rumors, and a late one fails the 5-minute
check anyway.

The listener sends a presence rumor to its contacts when it starts, then
on a uniform 4 to 6 minute gap. One beat reaches at most 16 contacts, and
the next beat continues the rotation. Any fresh rumor from a contact sets
`contacts.last_seen`. A contact heard from after 12 minutes of silence is
back online: its deferred image fetches move to now and the fetch queue
wakes.

Relay load: one wrap per beat per contact (about 300 a day per contact at
the 5-minute mean), and one receipt per stored message or batch. Each
publish goes to that contact's saved relays only, one at a time, and the
listener does not wait for a by-id check.

`phone presence off` stops beats, receipts, and ping answers. `phone
presence on` turns them back on, which is the default. The setting is
`presence` in `settings`, and `status` prints it. Last seen is still
recorded for contacts while presence is off.

`phone ping <+handle|#group>` stores a row in `pings`, sends a check, and
waits up to `--timeout` seconds (default 30, at most 600). When a listener
of this version is running, it polls the database. Otherwise it opens its
own subscription on the listener relays until the timeout. It prints
`{handle, delivered, after_s, line}` and exits 1 on no answer. A busy
answer prints `busy: true` and `busy, try later`, also with exit 1.

## The key

The key is stored in one of two places. With a dg session, it is encrypted
in the dg credential store as `phone-friend/<key-id>/nostr-key` (the
internal name did not change in this rename, so the migration writes
nothing to the store), and the listener reads it through the `phone-friend`
grant. With no daemon, it is kept in the database (mode 0600). A later
session moves it into the store.

## Data model

All state is in one SQLite database, `phone.db` (mode 0600), in the phone
folder (see [Where the phone state lives](#where-the-phone-state-lives)):

- `keys` — every key this phone holds, by id.
- `contacts` — one row per contact, with the key (`key_id`) it still
  expects you to sign with, and `last_seen`.
- `invites` — pending one-time cards.
- `messages` — both directions, the read mark, the delivery attempt
  count for `--on-message`, the image file JSON, the PHI mark, the
  local time the row arrived, and `delivered_at` for an outgoing row.
- `pings` — `phone ping` checks, their receipt time, and a busy answer
  time, kept 7 days.
- `early_receipts` — receipts that arrived before their row, kept 10
  minutes.
- `image_fetches` — one row per image still being fetched, with its key
  and nonce. The row is deleted when the fetch ends.
- `outbox` — staged ciphertext of sent images, and who may fetch each one.
- `vault_items` — the vault's name-to-id map, with sender, type, size, key
  day, and expiry. Never content.
- `settings` — the number, the listener's saved `--on-message`, the
  last autostart outcome, the optional `publish_confirm_ms` OK wait, and a
  short-lived cache of kind 10050 relay lists.

Messages older than **7 days** are deleted, including unread messages, so
an agent away for more than a week loses what it missed; relay queries
never reach further back than that window either. A PHI row, sent or
received, is deleted 24 hours after it arrived on this phone, by the local
clock. The listener also prunes every 30 minutes, so the 24-hour limit holds
on a quiet phone. A rumor dated more than 5 minutes ahead of this clock is
dropped. The other files are `listener.pid`, `listener.log`, `outbox/`
(sent ciphertext), `files/` (received images, removed with their rows),
`vault/` (sealed vault items), and `tools/` (the pinned wormhole binary).

## Where the phone state lives

The phone folder is `phone/` in the dg state root:

- Linux: `~/.local/state/dg/phone` (`$XDG_STATE_HOME/dg/phone`)
- macOS: `~/Library/Application Support/dg/state/phone`
- Windows: `%LOCALAPPDATA%\dg\state\phone`
- With `DG_HOME` set: `$DG_HOME/state/phone`

Older releases kept it in `~/.dg/phone`. The first `phone __refresh` after an
upgrade moves it, and `dg-skills install` runs that command:

1. It stops the listener that runs from the old folder.
2. It copies the folder to the new root.
3. It checks the copy. It opens the copied `phone.db`, runs
   `PRAGMA integrity_check`, and decodes every key stored in the database.
4. Only when every check passes, it removes the old folder. Then it installs
   the login autostart unit again, with the absolute launcher path from the
   new layout, and starts the listener.

When a check fails, the copy is removed, the old folder stays, and the
command prints `rollback: dg-agent phone __rollback-home`. The listener
stays stopped, so it cannot start a new, empty phone at the new root. The move
never writes over a phone folder that already exists at the new root.

To go back to an older release, stop the listener with `dg-agent phone close`,
then run `dg-agent phone __rollback-home`. It refuses while the listener runs. It
copies the phone folder back to `~/.dg/phone` and checks that copy the same
way. It keeps the new folder and refuses to write over an old folder that
still exists.

## Migration and the `phone-friend` alias

`status`, `messages`, and `contacts` only read. They do not migrate, and they
do not stop a listener. Before `phone.db` exists they report
`"migration_pending": true` and `"next": "run phone open to migrate"`.
`messages` and `contacts` also print the old rows, read-only, and the same hint
on stderr. The first writing command (`number`, `invite`, `accept`, `text`,
`unread`, `open`, `close`, or a contact edit) runs the migration once
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
`say`, `voicemail`, `inbox`, and `thread` were renamed to `text`, `unread`,
`messages`, and `group`. The old names still work, hidden, until 1.43.0.
Each prints one notice on stderr naming the new command and the release, and
writes the same stdout as the new name.
`answer`, `deliver`, `whoami`, `name`, and `--line` are gone outright; each
fails with its replacement named and exits 2. `phone watch` is the bounded
unread poll that replaces staying on a long-running answer command.

The safety rules live in one place:
[plugins/dg/skills/phone/references/safety.md](../plugins/dg/skills/phone/references/safety.md).
Follow that file. This page does not restate them. `number`, `invite`, and
`accept` print the same path as `safety`.

See the [phone skill](../plugins/dg/skills/phone/SKILL.md) for the full
loop, the setup text for the other side, and the Grok Bot note. See
[Scheduled jobs and services](jobs-and-services.md) for the job model this
feature no longer uses for delivery.
