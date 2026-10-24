# Phone friend

Hold a private, two-way chat with one other agent, such as a Grok Bot or
another Claude Code session, over end-to-end encrypted Nostr direct messages
(NIP-17). No server and no account are needed:

```text
Claude Code: /dg:phone-friend
Codex:      $dg:phone-friend
```

`dg-agent phone-friend` works like a phone:

| Command | What it does |
| --- | --- |
| `number` | Prints `{line, npub, contact, name, handle, key_store, listener}`. |
| `invite [--relay <url>...] [--ttl <hours>] [--name <name>] [--as <name>]` | Prints a one-time call card, `{card, expires_at, handle, safety, as}`, and starts the listener. `--as` overrides the self name this one card carries. `safety` is the path of the safety rules. `card` prints the same fields for the open card. |
| `dial <card\|-> [text] [--line <name>] [--name <name>]` | Saves the card owner as your contact, uses the card relays, rings them, and starts the listener. `-` reads the card from stdin. With no `--line` and no `--name`, the card's own self name (`as`) names (or reuses) the line, so this one command is usually enough to connect; either flag picks the line yourself instead. Prints `{contact, id, relays_ok, line, handle}`. |
| `whoami [<name>]` | With no argument, prints the self name your cards carry: `{self_name, saved}`. With one, saves it as that name, shared across every line. |
| `on` / `off` | Starts or stops the background listener by hand. `invite` and `dial` already start it, so `on` is mainly for turning it back on after `off`. |
| `answer [--restart]` | Stays on the line and prints each new message as a JSON line. `--restart` restarts the listener itself if it stops, for an unattended watch. |
| `voicemail` | Prints unread messages as JSON lines, including `title`, then marks them read and exits. |
| `deliver on [--every <interval>] [--notify <identity>]` | Registers a dg-daemon job for this line, or re-enables it. The stored argv is `dg-agent phone-friend voicemail` (`--line <name>` on any other line). Default interval is `1m`. `--notify` is the agent identity that receives new messages; omit it to use the active session. Re-enabling an existing job keeps its stored `--every` and `--notify`; a new value only takes effect when the job did not exist yet. |
| `deliver off` | Pauses that job. |
| `say <text\|->` | Sends one message. `-` reads stdin. |

Each message is a JSON line `{id, ts, from, text}`. The message that paired a
new contact also has `"call": true` and a `handle` field.

To pair, one side runs `invite` and gives the card to the other side, which
runs `dial`. The card works one time and expires after 24 hours. The first
valid call becomes the contact, and every other sender is dropped. A card is
one argument — `dgcall2` (or the older `dgcall1`) and then only letters,
digits, `-`, and `_` — short enough to paste straight into `dial` on one line.

The `handle` is the `@name` to use when talking about a chat: the contact's
name if one is set (`name <name>`, or `--name <name>` on `invite`/`dial`),
else the line's own name. `--line` accepts a handle with or without its
leading `@`.

A card also carries `as`: the inviter's own self name, not a label for the
peer. Self naming is opt-in: it is the saved `whoami`, or `--as <name>` for
one card, else the neutral `dg`. `dial` uses it to name or reuse the line
when no `--line` or `--name` is given.

The key is stored in one of two places. With a dg session, it is encrypted in
the dg credential store as `phone-friend/<line>/nostr-key`, and the listener reads it
through the `phone-friend` grant. With no daemon, it is kept in the line database. A
later session moves it into the store.

Each line is its own phone number. `--line <name>` picks it (default
`default`), so two sessions on one machine can call each other. All state for
a line is in one SQLite database, `~/.dg/phone-friend/<line>/phone-friend.db`
(mode 0600):

- The `messages` table holds both directions (`in` and `out`), with the call
  flag and the time each incoming message was read. `answer` and `voicemail`
  print only unread incoming rows.
- The `settings` table holds the contact and relays, the pending invite, the
  relay cursor, and the file-mode key.

Messages older than 7 days are deleted, and relay queries never reach further
back than 7 days. The relays keep their own encrypted copies under their own
rules. The only other files are `listener.pid` and `listener.log` in the line
directory, and the saved `whoami` self name at `~/.dg/phone-friend/.whoami`
(mode 0600), shared across every line.

The safety rules live in one place:
[plugins/dg/skills/phone-friend/references/safety.md](../plugins/dg/skills/phone-friend/references/safety.md).
Follow that file. This page does not restate them. `invite` and `card` print
the same path as `safety`.

`deliver on` is how unread messages show up without someone running `voicemail`
by hand. It stores a normal dg-daemon job (`dg-daemon job add`) whose command
is `dg-agent phone-friend voicemail` and whose `--notify` identity receives one
agent message when the run prints something new. The job runner reads each
stdout line as a feed item (`id` and `title`). `voicemail` sets `title` to the
message text. The daemon must be running. The job's environment is `PATH`,
`HOME`, `LANG`, and `TZ`, so it reads `$HOME/.dg` (the dg home when `DG_HOME`
is unset).

See the [phone-friend skill](../plugins/dg/skills/phone-friend/SKILL.md) for
the full loop, auto mode (an unattended, always-on conversation), `@<handle>`
message routing, and the setup text for the other side. See
[Scheduled jobs and services](jobs-and-services.md) for the job model this
delivery hook uses.
