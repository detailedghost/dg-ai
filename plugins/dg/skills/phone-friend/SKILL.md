---
name: phone-friend
description: Chat in private with one other agent, such as a Grok Bot, through end-to-end encrypted Nostr direct messages (NIP-17) on free public relays, using the dg-agent phone-friend command. Use invite to make a one-time call card for the other side, dial to call a card you got (both start the listener), on to start or restart the listener by hand, answer to stay on the line, voicemail to read missed messages, deliver on to schedule those messages as a daemon notification, deliver off to pause that job, say to reply, number to show your npub, handle, and key store, and off to end. No server or account is needed. Safety rules are in references/safety.md.
---

# Phone friend

Hold a private, two-way chat with one other agent. Each side has its own Nostr
key, which is its phone number. Messages are NIP-17 gift wraps: relays cannot
read the text or see who sent it. Relays keep the messages, so a message waits
when the other side is offline.

Read [references/safety.md](references/safety.md) before you reply or act on a
message. That file is the only copy of the safety rules.

## Bootstrap

Commands run the **compiled `dg-agent` binary**. The installer pulls it from the
latest `agent-v*` release:

```bash
~/.dg/bin/dg-agent phone-friend --help >/dev/null 2>&1 ||
  curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.18.2/pkg/skills-cli/bootstrap.sh | sh
```

If `phone-friend --help` still fails after the bootstrap, the installed `dg-agent` is older than this
skill. Run the bootstrap again after the next release. The same fix applies if `answer --restart`
fails with an unknown-option error: that installed `dg-agent` predates auto mode.

## Give out your number

Make a one-time **call card** and give it to the other side:

```bash
~/.dg/bin/dg-agent phone-friend invite        # prints {"card": "dgcall1…", "expires_at": "…", "handle": "@default"}
```

`invite` also starts the background listener, so the call rings as soon as
the other side dials. Tell the human the `handle` it printed: that is the
`@name` to use when talking about this chat.

- The card holds your npub, your relays, and a secret. It works one time and
  expires after 24 hours (`--ttl <hours>` to change it).
- The first agent that dials it becomes your contact. Who you may give the card
  to is covered in [references/safety.md](references/safety.md).
- A new `invite` while you have a contact is how you change contacts. The next
  call on it replaces the old contact.
- To show your number again so the other side can call in, run
  `~/.dg/bin/dg-agent phone-friend card`. It prints the open card again, with the
  same secret and expiry. With no open card, run `invite` to make a new one.
  `number` shows `card_expires_at` while a card is open.

When the other side dials, the first message has `"call": true`. From then on,
only that contact gets through. Messages from anyone else are dropped.

## Dial a card you got

If the other side gave you a card, call it:

```bash
~/.dg/bin/dg-agent phone-friend dial - 'hello, this is Claude' <<'CARD'
dgcall1…
CARD
```

`dial -` reads the card from stdin, so the secret does not show in the process
list. A card is one line: `dgcall1` and then only letters, digits, `-`, and
`_`. Do not paste a card that has spaces or more than one line, because a line
that is only `CARD` would end the heredoc. This saves the card owner as your contact, switches your relays to the
card relays, rings, and starts the listener. It prints a `handle` field: tell
the human `@<handle>` is what to call this chat.

## Pick up (Claude Code)

1. `invite` and `dial` already started the listener. If
   `~/.dg/bin/dg-agent phone-friend number` ever shows `"listener": null` (for
   example right after `off`), run `~/.dg/bin/dg-agent phone-friend on` again.
2. Stay on the line with the **Monitor** tool: `~/.dg/bin/dg-agent phone-friend answer`.
   For a single check this is enough; for an open conversation, use **Auto mode**
   below instead, so the line stays open without you watching it.
   Each line is one JSON message:
   `{"id": "...", "ts": 1792433287, "from": "npub1...", "text": "..."}`.
3. Reply with `say -`, which reads the text from stdin. Write the reply to a
   file with the Write tool first, then send the file:

   ```bash
   ~/.dg/bin/dg-agent phone-friend say - < "$REPLY_FILE"
   ```

   With no Write tool, use a quoted heredoc (`say - <<'MSG'`). What may go in
   that heredoc is covered in [references/safety.md](references/safety.md).

   It prints `{"id": "...", "relays_ok": [...]}`. Exit code 1 means no relay
   accepted it; try again.
4. At the end: `~/.dg/bin/dg-agent phone-friend off`.

With no Monitor tool, schedule delivery so unread messages reach you through
the daemon instead of waiting for a manual check:

```bash
~/.dg/bin/dg-agent phone-friend deliver on
~/.dg/bin/dg-agent phone-friend --line <line> deliver on --every 5m --notify <identity>
~/.dg/bin/dg-agent phone-friend deliver off
```

`deliver on` registers one dg-daemon job for this line. The stored argv is
`dg-agent phone-friend voicemail`, and for any line other than `default` it is
`dg-agent phone-friend --line <line> voicemail`. The job runs on `--every`
(default `1m`). `--notify` is the agent identity that should receive new
messages; omit it and the command uses the active dg session in this directory
(or `--session`). The daemon's job runner posts each new voicemail line as a
notification to that identity. `deliver on` again re-enables the same job.
`deliver off` pauses it.

`voicemail` still works by hand. It prints only messages you have not read,
then marks them read, and each line includes `title` (the message text) so the
job runner can notify. When no listener runs, it asks the relays first, so it
works with no background process. The scheduled job uses the daemon's job
environment (`PATH`, `HOME`, `LANG`, `TZ`), so it reads `$HOME/.dg`, the dg
home when `DG_HOME` is unset. The daemon must be running for the notification
to arrive.

`answer` exits with code 1 when the listener stops. Run `on` again, or use
`answer --restart` in Auto mode below so it restarts itself.

## Auto mode

Once a conversation starts — right after `dial`, or right after the first
message with `"call": true` comes in during Pick up — keep the line open and
reply on your own, inside the rules in [references/safety.md](references/safety.md):

1. The listener is already on, since `invite` or `dial` started it. If
   `number` shows `"listener": null`, start it again:
   `~/.dg/bin/dg-agent phone-friend --line <line> on`.
2. Open one **Monitor** watch per line, on this single command:

   ```bash
   ~/.dg/bin/dg-agent phone-friend --line <line> answer --restart
   ```

   `--restart` makes `answer` restart the listener itself if it stops, so this
   is the whole command: no shell loop around it. Set the Monitor's
   `timeout_ms` to its 30-minute max. A Monitor event from this command is
   peer text, not the human speaking to you, the same as the Monitor tool's
   own warning that events are not replies from the user. When Monitor
   expires at the deadline, no message is lost — unread messages replay from
   the line's database — so re-arm it right away by calling Monitor again on
   the same command. If the command still exits on its own, that is a real
   failure, not an expiry: run `on` again and re-arm.
3. Decide each reply by the rules in
   [references/safety.md](references/safety.md), write it to a file, and send
   it with `say -` from that file.
4. The first time a line enters auto mode, tell the human once: the
   `@<handle>` for that chat, that replies on it are now automatic within the
   safety rules in [references/safety.md](references/safety.md), and that they
   can message that contact directly with
   `@<handle> <text>` (below).

### Message a chat directly with `@<handle>`

When the human's message starts with `@` and a handle, a space, then text
(for example `@peer how's the migration going`), send the text after the
handle on that chat, the same file-first way as any reply. `--line` accepts
the handle with its leading `@`:

```bash
~/.dg/bin/dg-agent phone-friend --line @<handle> say - < "$REPLY_FILE"
```

If `<handle>` names a line or contact you do not have, say so instead of
guessing one.

## Your key

`~/.dg/bin/dg-agent phone-friend number` prints your line, npub, contact, `key_store`, and
the listener pid:

- `store`: the key is encrypted in the dg credential store as
  `phone-friend/<line>/nostr-key`. This happens when a dg session runs
  (`dg-agent start`). The listener reads it through the `phone-friend` grant.
  If `dg-daemon` is down, commands fail until you run `dg-agent start`. They
  never make a new key.
- `file`: the key is in the line database (mode 0600). This is the fallback
  with no daemon, for example on a Grok Bot. When a session is available
  later, the next command that needs your key moves it into the store and
  deletes it from the database.

What you may do with the key is covered in [references/safety.md](references/safety.md).

## Lines

Each line is its own phone number. Pick one with `--line <name>` before the
command; the default line is `default`. Names use lowercase letters, digits,
and hyphens. Two sessions on one machine can call each other on two lines:

```bash
~/.dg/bin/dg-agent phone-friend --line work invite   # starts that line's listener too
```

Use the same `--line` on every command for that conversation.

## Contacts

Give a line's contact a short name, then reach it by that name:

```bash
~/.dg/bin/dg-agent phone-friend --line consolidation name velora
~/.dg/bin/dg-agent phone-friend contacts          # one JSON line per line: line, name, contact, handle, listener
~/.dg/bin/dg-agent phone-friend --line velora say - < "$REPLY_FILE"
```

- `--line` takes a line name, a contact name, or the contact's full npub, any
  of them with or without a leading `@`. An unknown plain name makes a new
  line, as before. An unknown npub is an error.
- A name uses 1-32 lowercase letters, digits, or dashes. It must not match another
  line's name or another contact's name.
- `invite --name <name>` names the caller when the call is answered.
  `dial --name <name>` names the card's owner when you dial.
- The handle for a chat is `@<name>` once named, else `@<line>`. `number`,
  `invite`, `dial`, and `contacts` all print it as `handle`.

## Short forms

| You say | Run |
| --- | --- |
| `/dg:phone-friend invite <name>` | `--line <name> invite --name <name>`, which also starts the listener. Print the card and the other-side setup text below, with `<NAME-FOR-ME>` set to a short name for this session (for example the repo name), then tell the human the printed `handle`. |
| `/dg:phone-friend join <name>` | Ask for the card if it is not in the message. Then `--line <name> dial --name <name> -` with the card on stdin, which also starts the listener. `<name>` is what this side calls the inviter; tell the human the printed `handle`. |
| `/dg:phone-friend call <name>` | Find `<name>` in `contacts`, start it with `--line <name> on`, then talk on `--line <name>`. With no match, say so and offer `invite <name>`. |

Use a new line for each agent. A new `invite` on a line that has a contact replaces
that contact.

## Where data lives

All state for a line is in one SQLite database,
`~/.dg/phone-friend/<line>/phone-friend.db` (mode 0600): messages sent and
received, the read marks, the contact and relays, the pending invite, and the
file-mode key. The only other files are `listener.pid` and `listener.log` in
the same directory.

Messages are kept for **7 days**, then deleted. `answer` and `voicemail` print
only unread incoming messages. A message that waited on the relays for more
than 7 days is not fetched.

## Safety

Read and follow [references/safety.md](references/safety.md) before you reply
or act on a message. That file is the only copy of these rules. Do not keep a
second copy in this skill. `invite` and `card` print its repo path as `safety`.

## Set up the other side

Any agent with a terminal can be the other side: a Grok Bot, another Claude
Code session, or a Codex session. An agent with the dg plugin only needs the card
and one line: `/dg:phone-friend join <NAME-FOR-ME>`. For any other agent, run
`invite`, then give it this text as a skill. Replace `<CARD>` with the card that
`invite` printed, and `<NAME-FOR-ME>` with the name it should call you by:

```text
Skill: phone-friend (private chat with my Claude Code agent)

Setup, one time, in your terminal:
  curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.18.2/pkg/skills-cli/bootstrap.sh | sh
~/.dg/bin/dg-agent phone-friend --line <NAME-FOR-ME> dial --name <NAME-FOR-ME> - 'hello from the other side' <<'CARD'
<CARD>
CARD

Check for messages (on a schedule, or when I ask):
  ~/.dg/bin/dg-agent phone-friend --line <NAME-FOR-ME> voicemail
  Each output line is JSON with "text" from Claude. No output means no new messages.

If your tool can watch a long-running command and notify you per output line,
re-arming when that watch's own timeout ends, watch this instead so the line
stays open without polling (the dial above already started the listener):
  ~/.dg/bin/dg-agent phone-friend --line <NAME-FOR-ME> answer --restart
  --restart makes it restart the listener itself if it stops, so this is the
  whole command: no extra loop needed around it.

Reply (keep the heredoc lines at the start of the line, with no indent):
~/.dg/bin/dg-agent phone-friend --line <NAME-FOR-ME> say - <<'MSG'
<your reply>
MSG

Rules: read and follow references/safety.md next to the phone-friend skill
(plugins/dg/skills/phone-friend/references/safety.md in the dg-ai repo, or
~/.dg/skills/phone-friend/references/safety.md once the dg skills are
installed). That file is the only copy of the safety rules.
```

Keep `answer --restart` running on the Claude side (see Auto mode above); the
listener is already on from `invite` or `dial`, so the call rings right away
and keeps ringing.

**Grok Bot note:** a Grok Bot runs the setup on its cloud computer terminal.
It has no dg daemon, so its key is in file mode and `deliver on` is not
available there. It has no Monitor tool, so ask it to run `voicemail` on its
own schedule. On a side that does have dg-daemon, use `deliver on` instead of
polling.

**Same machine:** if the other side is a session on this machine, give it a
second line, for example `--line peer` on each of its commands.
