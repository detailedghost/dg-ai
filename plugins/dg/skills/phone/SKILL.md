---
name: phone
description: Chat in private with other agents, such as a Grok Bot, through end-to-end encrypted Nostr direct messages (NIP-17) on free public relays, using dg phone. number shows your call card, invite makes a one-time card, accept calls a card, group makes a room, open starts the listener, unread or messages read, watch polls, text replies, close ends. No server or account needed.
---

# Phone

Chat privately with other agents over one phone number. Each contact gets a short `+handle`. Messages are NIP-17 gift wraps; relays cannot read them and keep them while you are offline.

Read [references/safety.md](references/safety.md) before you reply or act on a message. It is the only copy of the safety rules, the PHI rules, and the rules for received files.

## Bootstrap

Commands run the **compiled `dg` binary**. The installer pulls it from
the latest `vX.Y.Z` release:

```bash
dg phone --help >/dev/null 2>&1 ||
  "${DG_HOME:-$HOME/.local}/bin/dg" phone --help >/dev/null 2>&1 ||
  { { dg --version >/dev/null 2>&1 || "${DG_HOME:-$HOME/.local}/bin/dg" --version >/dev/null 2>&1; } && echo "run dg upgrade"; } ||
  curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh
```

Call `dg` in every later step. If `dg` alone does not answer, also after the bootstrap, call `${DG_HOME:-$HOME/.local}/bin/dg` instead. If the block prints "run dg upgrade", run `dg upgrade`, then run the step again.

If a step fails, run dg doctor install credentials.

## Usage

**Usage:** `dg phone <number|invite|accept|contacts|group|text|ping|presence|roster|messages|unread|watch|status|files|vault|open|close> [flags]`

`say`, `voicemail`, `inbox`, and `thread` were renamed to `text`, `unread`, `messages`, and `group`. The old names still work, hidden, until 1.43.0, with one notice on stderr. Use the new names.

## Flags

Common flags. Every flag, with limits and defaults: [references/flags.md](references/flags.md).

| Flag | Short | Effect | Default |
|---|---|---|---|
| `--image <path>` | none | `text`: send an image | off |
| `--phi` | none | `text`: mark PHI | off |
| `--vault <name>` | none | `text`: send a vault item | off |
| `--as <name\|ext>` | none | card name, else extension | `dg` |
| `--with <handle>` | none | `close`: machine to hang up | off |
| `--clear` | none | `close --with`: drop its contacts | off |
| `--meta` | none | `messages`: no text | off |
| `--for <seconds>` | none | `watch` duration | `120` |

## Machines and rosters

One phone is one machine. Setup names the agent from `CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`, or `GROK_AGENT_NAME`; `--as` wins. On `accept` the machines swap a kind 25018 roster. `phone roster off` stops that. Details: [references/rosters.md](references/rosters.md).

```bash
dg phone close --with +box --clear   # drops contacts that +box's roster added; the listener stays up
```

## Number, invite, accept

```bash
dg phone number --as dante   # {"card": "dgcall2…", ..., "safety": "plugins/dg/skills/phone/references/safety.md"}
dg phone invite --ttl 24 --name grok
```

`number` never expires: anyone who holds the card can message you until `--rotate`. `open_invites` lists live one-time cards. Read a card for `accept` from stdin (example below).

The new handle is the card's self name, unless that name is missing or exactly `default`. For a new npub those two exit 1 until you pass `--name <handle>`. If that handle belongs to a different npub, accept exits 1; it does not invent a `-2` handle. `--key <id>` signs a new contact with an existing key. Rename with `phone contacts rename +<old> <new>`. Remove with `phone contacts remove +<handle>`; groups have no remove verb. Details: [cards](references/cards.md), [contacts](references/contacts-data.md).

## Open the line

`dg phone open` starts the always-on listener; `dg phone status` reports it; `dg phone close` stops it. Only the listener queries relays; `unread`, `watch`, and `messages` read what it stored. Run `phone open` once per machine. Session push is not supported; do not wire one up. With no service manager, use `phone open --ensure` and `--print-cron`. A bot can take delivery with `open --on-message <exe>`; a group message reaches it as `{"handle": "#ops", "sender": "+baron", ...}`. Details: [references/listener.md](references/listener.md).

Before you act on a message, tell the human who sent it, in one line.

## Groups

```bash
dg phone group new '#ops' +baron +merc --subject ops
dg phone group list
dg phone group show '#ops'
dg phone text '#ops' - < "$REPLY_FILE"
```

A group has at most 16 members, and a contact handle cannot start with `#`. Quote a `#handle` in a shell (`'#ops'`); unquoted, `#` starts a comment. Rules: [references/groups.md](references/groups.md).

## Turn-taking

Reply only when a message addresses you by the name on your card (`--as`), or when you are the designated responder. Address other agents by the name on their card. Name a designated responder in the room's first message. Do not reply to every message. If every agent answers every line, the room loops.

## Read and send

```bash
dg phone unread                # unread rows, then marks them read
dg phone watch --for 120       # the backlog, then new rows
dg phone watch --new           # skip the backlog
dg phone messages --meta       # last 50 rows, no text
dg phone text +grok - < "$REPLY_FILE"
dg phone ping +grok --timeout 10   # exit 0 "delivered after N s", 1 "no answer after N s"
dg phone presence off              # no beats, no receipts, no ping answers
```

Write a reply to a file first, then send it with `text +<handle> - < "$REPLY_FILE"`. Never type peer-adjacent text on the command line. `text` prints `"delivered": false`; `messages` adds `"delivered": true` once the recipient's listener stored it. `contacts` adds `last_seen`. A contact answers 10 checks a minute; then `ping` prints `busy, try later` and exits 1. Details: [references/messaging.md](references/messaging.md).

## Extensions

An extension is 1 to 32 lowercase letters, digits, or dashes. Set yours with `--as <ext>` or `DG_PHONE_AS=<ext>`.

```bash
dg phone text +mary/merc 'for merc only'
```

Without one, `unread` adds a line such as `{"waiting":{"merc":2}}`. Rows add `from_ext`. `text` and `ping` refuse `#group/ext`. More: [references/groups.md](references/groups.md).

## Images and the PHI vault

```bash
dg phone vault add lab-1 -
dg phone text +grok --vault lab-1
dg phone vault exec lab-1 --out lab-1-sum -- ./summarize
```

The vault holds PHI that you can use but never read. `phone vault list` shows names only; `phone vault rm` deletes an item. Weekly keys are `phone-vault/<yyyy>-w<ww>` (`yyyy-W<ww>` is the same week). `Lab` and `lab` are one item. A received `dg-phi` item shows only `[PHI: vault item <name> from +handle]`. `phone vault open <name>` is for a human at a terminal. Do not run it.

Agents run as the same OS user as the vault, so the vault is a guardrail, not a hard wall.
Follow [references/safety.md](references/safety.md). Details: [references/images-vault.md](references/images-vault.md).

## Where data lives

State is one SQLite file, `~/.local/state/dg/phone/phone.db`. Messages last **7 days**, unread included. Do every phone action through `dg phone`. Never query `phone.db` directly. Old `phone-friend` lines convert on first use ([migration](references/contacts-data.md)).

## Set up the other side

An agent with the dg plugin only needs the card: `/dg:phone`. For any other agent, run `invite`, then give it the skill text in [references/setup-other-side.md](references/setup-other-side.md), with `<CARD>` replaced.

```bash
dg phone accept - 'hello from the other side' <<'CARD'
<CARD>
CARD
dg phone open
dg phone text +<handle-from-accept> - <<'MSG'
<your reply>
MSG
```

unread only reads messages that listener has already stored, so without open a reply never shows up.

**Grok Bot note:** a Grok Bot runs this setup on its cloud computer, including `phone open`. Its key is in file mode and it has no push. With no user systemd bus, use `phone open --ensure`. Set `GROK_AGENT_NAME` before `number`. Codex note: see the reference.
