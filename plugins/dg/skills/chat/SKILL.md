---
name: chat
description: Talk to a human through a live local chat page that dg-daemon serves on loopback and opens in the default browser, with no extension needed, using the dg-agent CLI. The browser extension pairs by itself when a session starts. Pass --ext to also require the dg-ai-extension. Use start to register a session and open the chat page, recv to collect queued human messages, send to reply (or send --to to message another agent identity), progress to publish state, spawn to add a background session or to run a command inside one, stage to show a file, manifest to publish runnable commands, memory to record and search this agent's own notes, and close to finish. Every session is loopback-only and capability-gated.
---

# Chat

Hold a real conversation with a human in a browser tab while you work. The
`dg-daemon` daemon hosts many chat sessions on loopback and serves the chat page
itself, and this skill is the agent side of the loop. The page needs no
extension. When the `dg-ai-extension` is loaded, it pairs with every new session
on its own. No code and no human step are needed. Pass `--ext` to require the
extension.

Commands run the **compiled `dg-agent` binary** from your PATH — a
self-contained binary, no Bun needed at runtime. `dg-agent start` launches the
daemon itself when none is running, by resolving `dg-daemon` next to it in the
same directory, so both binaries must be installed together. On first use,
bootstrap them once (the installer pulls `dg-agent` from the latest `agent-v*`
release and `dg-daemon` from `daemon-v*`, alongside `dg-skills` from
`skills-v*`):

```bash
dg-agent --version >/dev/null 2>&1 ||
  "${DG_HOME:-$HOME/.local}/bin/dg-agent" --version >/dev/null 2>&1 ||
  curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh
```

Call `dg-agent` in every later step. If `dg-agent` alone does not answer, also after the bootstrap, call `${DG_HOME:-$HOME/.local}/bin/dg-agent` instead.

If the bootstrap fails, run `dg-skills doctor install` and retry.

The gate tests `dg-agent`, **not** `dg-skills`. A machine that has already used
`browser`, `demo` or `proto` already has `dg-skills`, so gating on that binary
would short-circuit and `dg-agent` would never arrive.

On Windows PowerShell, pipe the repository's raw `bootstrap.ps1` to
`Invoke-Expression`.

Then run every command through it:

```bash
dg-agent <command> <args>
```

## Flags

| Flag | Short | Effect | Default |
|---|---|---|---|
| `--ext` | none | Same as the default, and the extension must be installed. | off (local is the default) |

To use the extension, run the gate command, then the line below it:

```text
--ext only: dg-skills require-extension chat || exit 1
dg-agent start --ext --open
```

Extension details and WSL networking for a Windows-side browser:
[references/extension.md](references/extension.md).

## Pair the browser

Run this command:

```bash
dg-agent start
```

It prints one of two lines on stderr and prints nothing on stdout.

Paired:

```text
Paired <identity> (<id8>) with the browser extension.
```

Nothing more to do. Go to the loop below.

No extension:

```text
No browser extension is connected. Install it with: dg-skills install
```

1. Run `dg-skills install`.
1. Ask the human to open `chrome://extensions`, turn on Developer mode, and choose **Load unpacked** once. The folder path is in the `dg-skills install` output. This is the only human step.
1. Run `dg-agent start` again. It prints the Paired line.

Every later session pairs on its own. The human does not unpair or pair again.
If the human clicks **Unpair** in the popup, that session stays unpaired until it closes.

## The loop

```bash
dg-agent start --open              # register a session, open the chat page
dg-agent progress --state running  # tell the human you are working
dg-agent send "Looking at it now." # say something
dg-agent progress --state awaiting-input
dg-agent recv --block              # wait for their reply
dg-agent close                     # finish the session
```

`recv` prints one JSON object per call and acknowledges the message only after
printing it, so a crash mid-print re-delivers rather than loses. Without
`--block` it returns immediately with whatever is queued.

## Commands

- `start [-w <label>] [--orchestrator] [-a <name>] [--open] [--ext] [--print-session-id] [--json]` —
  start or reuse the daemon and register a new session. The extension adopts
  the session. `start` prints one line on stderr and nothing on stdout. The
  line is `Paired <identity> (<id8>) with the browser extension.` or
  `No browser extension is connected. Install it with: dg-skills install`.
  `--print-session-id` prints only the session id on stdout. `--json` prints
  `{"sessionId","port","extensionLinked"}`. `--open` opens the chat page in the
  default browser through a one-time code and prints no URL. The code works
  once, within 60 seconds. On WSL it does not open a browser unless
  `DG_OPEN_WINDOWS=1` is set. `--ext` gates on the extension and behaves like
  the default. `-w` attaches a workset label, which is how the chat page groups
  sessions in its rail. The session token never appears in output. Pairing
  details are in [references/extension.md](references/extension.md).
- `dg-daemon status` — report the live daemon's status, or that none is
  running. This runs on the daemon binary, not `dg-agent`.
- `recv [--block] [--timeout <ms>]` — receive the next queued message
  addressed to this session: a human reply from the chat page, or an
  agent-to-agent message addressed to this agent's identity. The daemon
  checks the human queue first, since a human is waiting on a browser tab
  and another agent is not, and only checks the agent queue once the human
  queue is empty. `--timeout` defaults to 30000 ms and applies only with
  `--block`.
- `send <body> [--to <identity>]` — send one complete agent message. Without
  `--to` it lands on the human's chat page, as it always has. With `--to
  <identity>` it queues for that agent identity instead and never reaches the
  human's canvas. It waits there until a session under that identity calls
  `recv`, for up to 7 days. The daemon prunes whatever nobody claims by then,
  so a mistyped identity does not leave a row behind forever. That `recv`
  result carries `from` and `to` naming both identities, so a reply is one
  more `send --to` back. The sending session never gets its own message
  back; addressing your own identity still reaches your other live sessions,
  just not the one that sent it.

  Delivery is at-least-once, not exactly-once. A message is acknowledged only
  after `recv` prints it, so a process that dies in between hands that message
  to the next session under the same identity — which, unlike the human queue,
  may be a different process. Treat a repeated `from`/`body` pair as a repeat,
  not as a second instruction.
- `progress --state <running|awaiting-input>` — publish an explicit state. Any
  other value is rejected.
- `spawn [--workset <label>] [--orchestrator] [--agent-identity <name>] [-- <command...>]` —
  spawn another background chat session. Without `--`, it prints the bootstrap
  JSON. With `--`, it runs `<command...>` with `DG_SESSION_ID` set to the new
  session and exits with the exit code of that command. Example:
  `dg-agent spawn --workset review -- bun test`.
- `stage <path>` — stage an asset for later presentation and print its id. The
  bytes are encrypted at rest and served only to the owning session.
- `overwatch <subcommand>` — manage the shared launch board; see the `overwatch`
  skill for its workflow and commands.
- `close` — close this chat session.
- `manifest --commands <path> [--subagents <path>]` — publish the commands the
  human may run from the chat composer, and optionally the subagent names they
  may `@`-mention.

`-s, --session <id>` selects a session explicitly. Without it, the CLI uses
`DG_SESSION_ID`, then the sole session whose realpath-matching cwd matches
yours.

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
| 4 | protocol mismatch between this CLI and the daemon it found or started |
| 5 | **reserved:** `recv --block` timed out with no message |
| 6 | the session closed while `recv` was blocked |

Code 5 is the one to branch on: it means "nothing arrived yet", not an error.
Loop on it rather than treating it as a failure. Code 6 means the human ended
the conversation and you should stop.

Code 4 has three sources: `start` refusing to attach to a running daemon from
another release, `start` finding that the sibling daemon it just launched is
from another release, and any session command refusing at the pid file before
it connects. All three name the two versions and the remedy, so read the
message rather than retrying.

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

- Every session is **loopback-only** and capability-gated. A token authorises
  one session; it is never written to a log, a URL, or a command output.
- The daemon trusts any process that the same user runs on this machine, and
  it does so silently. A local program can fake an `Origin` header. The daemon
  id pin stops a process on a free port. It does not stop a proxy that copies
  the live daemon.
- Messages and staged assets are encrypted at rest. The data key comes from the
  OS keychain when one is available, and from a file-backed key otherwise.
- `~/.dg` is two independent trees: `daemon/` holds the encrypted `daemon.db`
  that stores those messages and assets, and `agents/` holds session files
  plus the plain-text `memory.db` behind `memory` — plain text on purpose,
  since FTS5 cannot index ciphertext.
- Chat sessions live in the daemon database, not as files under `agents/sessions`. Existing session files are imported on startup and then removed. Once an agent has claimed a session, `send`, `progress`, and `recv` may come and go. A gap between those commands does not reap the session or mark the agent gone. The claim is released only after a long quiet period with no CLI command, and the session is then archived even if the chat page is still open. Extension keepalives do not keep a released claim alive. A background pass trims the archive and the message rows that belonged to it, and checkpoints the database. `dg-daemon sessions clear` archives sessions whose claim has been released. Sessions whose claim is held between commands are left alone.
- `dg-skills install` refreshes `dg-agent` and `dg-daemon` too, alongside
  itself, so re-running it keeps all three binaries current.
