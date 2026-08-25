---
name: chat
description: Talk to a human through a live browser chat window while you work, using the companion dg-ai-extension, the dg-agent CLI and the dg-daemon daemon. Use start to register a session and open the chat page, recv to collect queued human messages, send to reply (or send --to to message another agent identity), progress to publish state, spawn to add a background session, stage to show a file, manifest to publish runnable commands, memory to record and search this agent's own notes, and close to finish. Every session is loopback-only and capability-gated.
---

# Chat

Hold a real conversation with a human in a browser tab while you work. The
`dg-daemon` daemon hosts many chat sessions on loopback, the `dg-ai-extension`
renders them, and this skill is the agent side of the loop.

Commands run the **compiled `dg-agent` binary** at `~/.dg/bin/dg-agent` — a
self-contained binary, no Bun needed at runtime. `dg-agent start` launches the
daemon itself when none is running, by resolving `dg-daemon` next to it in the
same directory, so both binaries must be installed together. On first use,
bootstrap them once (the installer pulls `dg-agent` from the latest `agent-v*`
release and `dg-daemon` from `daemon-v*`, alongside `dg-skills` from
`skills-v*`):

```bash
DG_AGENT="$HOME/.dg/bin/dg-agent"
if [ ! -x "$DG_AGENT" ]; then
  LOCAL_BOOTSTRAP="${CLAUDE_PLUGIN_ROOT:-}/pkg/skills-cli/bootstrap.sh"
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "$LOCAL_BOOTSTRAP" ]; then
    sh "$LOCAL_BOOTSTRAP"
  else
    curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/master/pkg/skills-cli/bootstrap.sh | sh
  fi
fi
```

The gate tests `dg-agent`, **not** `dg-skills`. A machine that has already used
`browser`, `demo` or `proto` already has `dg-skills`, so gating on that binary
would short-circuit and `dg-agent` would never arrive.

On Windows PowerShell, run the local `bootstrap.ps1` through
`$env:CLAUDE_PLUGIN_ROOT` when available; otherwise pipe the repository's raw
`bootstrap.ps1` to `Invoke-Expression`.

Then run every command through it:

```bash
"$DG_AGENT" <command> <args>
```

## The loop

```bash
"$DG_AGENT" start --open              # register a session, open the chat page
"$DG_AGENT" progress --state running  # tell the human you are working
"$DG_AGENT" send "Looking at it now." # say something
"$DG_AGENT" progress --state awaiting-input
"$DG_AGENT" recv --block              # wait for their reply
"$DG_AGENT" close                     # finish the session
```

`recv` prints one JSON object per call and acknowledges the message only after
printing it, so a crash mid-print re-delivers rather than loses. Without
`--block` it returns immediately with whatever is queued.

## Commands

- `start [-w <label>] [--orchestrator] [-a <name>] [--open]` — start or reuse the
  daemon and register a new session. `--open` opens the bootstrap URL in the
  default browser. `-w` attaches a workset label, which is how the chat page
  groups sessions in its rail.
- `status` — report the live daemon's status, or that none is running.
- `recv [--block] [--timeout <ms>]` — receive the next queued human message.
  `--timeout` defaults to 30000 ms and applies only with `--block`.
- `send <body> [--to <identity>]` — send one complete agent message. Without
  `--to` it lands on the human's chat page, as it always has. With `--to
  <identity>` it queues for that agent identity instead and never reaches the
  human's canvas — it waits there until a session under that identity calls
  `recv`. That `recv` result carries `from` and `to` naming both identities, so
  a reply is one more `send --to` back. The sending session never gets its own
  message back; addressing your own identity still reaches your other live
  sessions, just not the one that sent it.
- `progress --state <running|awaiting-input>` — publish an explicit state. Any
  other value is rejected.
- `spawn [--workset <label>] [--orchestrator] [--agent-identity <name>]` — spawn
  another background chat session and print its bootstrap JSON.
- `stage <path>` — stage an asset for later presentation and print its id. The
  bytes are encrypted at rest and served only to the owning session.
- `close` — close this chat session.
- `manifest --commands <path> [--subagents <path>]` — publish the commands the
  human may run from the chat composer, and optionally the subagent names they
  may `@`-mention.

`-s, --session <id>` selects a session explicitly. Without it, the sole session
whose realpath-matching cwd matches yours is used.

## Memory

Four verbs read and write this agent's own long-term memory, and none of them
need a live daemon: the CLI opens `~/.dg/agents/memory.db` itself, so every verb
below works with no daemon running at all.

- `memory write <title> [body] [--kind <kind>] [--workset <label>] [--identity
  <name>]` — record one memory. The body is the argument, or stdin when the
  argument is left off. Writing the same title again replaces what this agent
  knew under that title instead of adding a duplicate; leaving out `--kind`
  leaves an existing kind alone. A blank title or body is refused, and the
  body is capped at `CHAT_MAX_MESSAGE_BODY_BYTES` — the same bound `send` puts
  on a message body. Prints the memory id.

  A title starting with `-` needs a `--` separator first, or Commander reads
  it as an unknown option: `memory write -- "-1 on call" "body"`.
- `memory search [query] [--workset <label>] [--identity <name>] [--limit <n>]
  [--offset <n>] [--full]` — find this agent's memories, most relevant first.
  Free text only: punctuation an FTS5 parser would choke on is dropped before
  matching, so no query is ever a syntax error, though one that is nothing but
  punctuation returns nothing rather than the full recent list. With no query
  at all it lists the most recent first. One line per hit — id, date, workset,
  title — unless `--full` prints the whole record as JSON, one per line. Pages
  default to 20 hits and cap at 100.
- `memory read <id> [--full]` — print one memory as text, or the whole record
  as JSON with `--full`.
- `memory forget <id>` — remove one memory.

`read` and `forget` both exit 1 on an id that is not there.

The agent identity comes from the session file on disk: the sole session
registered from this working directory by default, `-s <id>` to name a
specific one, or `--identity <name>` to override either outright.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | success |
| 1 | general failure |
| 2 | no port available |
| 3 | WSL NAT networking — mirrored mode is required |
| 4 | protocol mismatch between this binary and the running daemon |
| 5 | **reserved:** `recv --block` timed out with no message |
| 6 | the session closed while `recv` was blocked |

Code 5 is the one to branch on: it means "nothing arrived yet", not an error.
Loop on it rather than treating it as a failure. Code 6 means the human ended
the conversation and you should stop.

## Manifest JSON format

`--commands` takes a JSON array. Each entry is a label, a real argument vector,
and its placeholder parameters. A placeholder occupies a **whole** argv element,
so nothing is ever assembled by string concatenation:

```json
[
  {
    "label": "run tests",
    "argv": ["bun", "test"],
    "params": []
  },
  {
    "label": "echo",
    "argv": ["echo", "{message}"],
    "params": [{ "name": "message", "type": "string" }]
  }
]
```

`--subagents` takes a plain JSON array of names:

```json
["reviewer", "security"]
```

A command the human runs this way executes without waking you — that is the
point of publishing it.

## Notes

- Every session is **loopback-only** and capability-gated. A token authorises one
  session; it is never written to a log or a URL query string.
- Messages and staged assets are encrypted at rest. The data key comes from the
  OS keychain when one is available, and from a file-backed key otherwise.
- `~/.dg` is two independent trees: `daemon/` holds the encrypted `daemon.db`
  that stores those messages and assets, and `agents/` holds session files
  plus the plain-text `memory.db` behind `memory` — plain text on purpose,
  since FTS5 cannot index ciphertext.
- On WSL the daemon needs **mirrored** networking mode. NAT mode cannot reach the
  loopback port from the Windows-side browser, and the daemon exits with code 3
  rather than pretending to be reachable.
- `dg-skills install` refreshes `dg-agent` and `dg-daemon` too, so re-running it keeps all
  binaries current.
