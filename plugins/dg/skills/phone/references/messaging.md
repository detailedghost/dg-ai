# Unread, messages, text, delivery, presence

## Unread and messages

```bash
dg phone unread            # unread rows, oldest first, then marks them read
dg phone watch --for 120   # the unread backlog, then rows that arrive while it runs
dg phone watch --new       # skip the backlog; only rows that arrive after this starts
dg phone messages             # the last 50 rows, both directions, read and unread
dg phone messages --meta      # the same rows with no message text
dg phone messages +grok -n 10 # the last 10 one-to-one rows with one contact
dg phone messages '#ops'      # that group; each line is [#ops] +sender: ...
```

`unread` is one check. `watch` repeats that check until `--for` elapses.
Both are for a poller with no hook, such as a Grok Bot with no persistent
process. Each pass prints unread incoming rows, oldest first, in one
transaction, then marks them read. A message that arrived between two `watch`
runs is still unread, so the next run prints it. No output means nothing
unread arrived. `--new` skips the backlog and prints only messages that
arrive after that process starts. `messages` never writes, so two calls on the
same handle see the same `read` flags. It includes incoming and outgoing,
read and unread. A handle selects that contact's npub. `--meta` leaves
`text` out of each messages row.

## Text

```bash
dg phone text +grok 'hello'
dg phone text +grok - < "$REPLY_FILE"
```

`text <handle> <text|->` sends one message, signed with whichever key that
contact still knows (a contact on an old key keeps working after you
`--rotate` your number). `-` reads the text from stdin, capped at 64 KiB;
write a reply to a file with the Write tool first when one is available,
then send the file with `text +<handle> - < "$REPLY_FILE"`, rather than
typing peer-adjacent text on the command line.

The send goes to the contact's saved relays, the recipient's NIP-17 kind
10050 relays when that list is published, and this phone's own relays. The
list is deduplicated and capped at 10, and still keeps one card relay and
one of our relays when the kind 10050 list is long. A query string is part of
the relay identity; a fragment is not. Lookup sockets are closed with the
publish sockets. Kind 10050 is looked up with a 2
second bound and cached for 10 minutes. The printed JSON is
`{"handle": "+name", "id": "...", "relays_ok": [...], "relays_unconfirmed": [...], "relays_failed": [{"relay": "wss://...", "reason": "..."}]}`.
`relays_ok` confirmed the event. `relays_unconfirmed` timed out waiting for
OK. `relays_failed` rejected it or could not be dialed. The OK wait defaults
to 10 seconds. `DG_PHONE_PUBLISH_CONFIRM_MS`, or the setting
`publish_confirm_ms`, changes it. Values below 5000 are raised to 5000, and
values above 60000 are lowered to 60000. The environment variable wins. A
relay that times out is checked by event id, and the outgoing row is saved
unless every relay explicitly rejected the send.

A message to an npub the recipient has since rotated stays sealed to the old
key. `relays_ok` means relays stored the gift wrap. It is silent about
whether that npub is still the one they read.

`phone open` pings its relay sockets and reconnects when a ping fails. Every
2 to 5 minutes, on a jittered gap, the listener probes one relay. If that
subscription has gone quiet, the process subscribes again and fetches what
it missed. The log line is `phone: listener heartbeat`,
`phone: listener resubscribe`, or `phone: listener probe-failed`, with no
message text.

## Delivery and presence

A running listener answers each message it stores with a small encrypted
receipt, and every 4 to 6 minutes sends each contact an encrypted presence
beat. Both are gift wraps like messages. A beat is an ephemeral wrap, so
relays do not keep it. Receipts go only to contacts, and nothing answers a
receipt or a beat.

- `text` prints `"delivered": false`. `messages` adds `"delivered": true` to an
  outgoing row once a recipient's listener stored it. A group row counts
  the first member. `unread` prints incoming rows only, so it has no
  `delivered` field.
- `contacts` adds `last_seen`: the ISO time of the newest rumor from that
  contact, or `null`.

```bash
dg phone ping +grok              # prints {"handle": "+grok", "delivered": true, "after_s": 2, "line": "delivered after 2 s"}
dg phone ping '#ops' --timeout 10
```

`ping` sends one check and waits for its receipt. It exits 0 on
`delivered after N s` and 1 on `no answer after N s`. A contact answers at
most 10 checks a minute from you. The next 10 get a busy answer, and `ping`
prints `busy, try later` and exits 1. Receipts for messages have no cap. A `#group` counts
the first member that answers. With the listener running, `ping` reads the
receipt from the database. Without it, `ping` listens on the relays itself
until the timeout.

```bash
dg phone presence       # prints {"presence": "on"}
dg phone presence off   # no beats, no receipts, no ping answers
```

`presence` is on by default, and `status` shows it. Off stops the beats,
the receipts, and the answers to checks. The listener still records when
it last heard from each contact.

