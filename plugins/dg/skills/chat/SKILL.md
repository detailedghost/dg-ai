---
name: chat
description: Talk to a human through a live browser chat window while you work, using the companion dg-ai-extension and the dg-server daemon. Use start to register a session and open the chat page, recv to collect queued human messages, send to reply, progress to publish state, spawn to add a background session, stage to show a file, manifest to publish runnable commands, and close to finish. Every session is loopback-only and capability-gated.
---

# Chat

Hold a real conversation with a human in a browser tab while you work. The
`dg-server` daemon hosts many chat sessions on loopback, the `dg-ai-extension`
renders them, and this skill is the agent side of the loop.

Commands run the **compiled `dg-server` binary** at `~/.dg/bin/dg-server` — a
self-contained binary, no Bun needed at runtime. On first use, bootstrap it once
(the installer pulls `dg-server` from the latest `server-v*` release, alongside
`dg-skills` from `skills-v*`):

```bash
DG_SERVER="$HOME/.dg/bin/dg-server"
if [ ! -x "$DG_SERVER" ]; then
  LOCAL_BOOTSTRAP="${CLAUDE_PLUGIN_ROOT:-}/pkg/skills-cli/bootstrap.sh"
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "$LOCAL_BOOTSTRAP" ]; then
    sh "$LOCAL_BOOTSTRAP"
  else
    curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/master/pkg/skills-cli/bootstrap.sh | sh
  fi
fi
```

The gate tests `dg-server`, **not** `dg-skills`. A machine that has already used
`browser`, `demo` or `proto` already has `dg-skills`, so gating on that binary
would short-circuit and `dg-server` would never arrive.

On Windows PowerShell, run the local `bootstrap.ps1` through
`$env:CLAUDE_PLUGIN_ROOT` when available; otherwise pipe the repository's raw
`bootstrap.ps1` to `Invoke-Expression`.

Then run every command through it:

```bash
"$DG_SERVER" <command> <args>
```

## The loop

```bash
"$DG_SERVER" start --open              # register a session, open the chat page
"$DG_SERVER" progress --state running  # tell the human you are working
"$DG_SERVER" send "Looking at it now." # say something
"$DG_SERVER" progress --state awaiting-input
"$DG_SERVER" recv --block              # wait for their reply
"$DG_SERVER" close                     # finish the session
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
- `send <body>` — send one complete agent message.
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
- On WSL the daemon needs **mirrored** networking mode. NAT mode cannot reach the
  loopback port from the Windows-side browser, and the daemon exits with code 3
  rather than pretending to be reachable.
- `dg-skills install` refreshes `dg-server` too, so re-running it keeps both
  binaries current.
