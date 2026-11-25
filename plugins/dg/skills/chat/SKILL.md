---
name: chat
description: "Talk to a human through a live local chat page that the dg daemon serves on loopback and opens in the default browser, no extension needed. Commands: start, recv, send (or send --to another agent identity), progress, spawn, stage, manifest, memory, close. The extension pairs by itself; pass --ext to require it. Every session is loopback-only and capability-gated."
---

# Chat

Hold a real conversation with a human in a browser tab while you work. The
dg daemon hosts many chat sessions on loopback and serves the chat page. This
skill is the agent side of the loop. The page needs no extension. A loaded
`dg-ai-extension` pairs with every new session on its own. Pass `--ext` to
require it.

Commands run the **compiled `dg` binary** from your PATH, with no Bun at runtime. `dg agent start` launches the daemon itself from the same binary. On first use, bootstrap once (the installer pulls `dg` from the latest `vX.Y.Z` release):

```bash
dg agent --help >/dev/null 2>&1 ||
  "${DG_HOME:-$HOME/.local}/bin/dg" agent --help >/dev/null 2>&1 ||
  { { dg --version >/dev/null 2>&1 || "${DG_HOME:-$HOME/.local}/bin/dg" --version >/dev/null 2>&1; } && echo "run dg upgrade"; } ||
  curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh
```

Call `dg` in every later step. If `dg` alone does not answer, also after the bootstrap, call `${DG_HOME:-$HOME/.local}/bin/dg` instead. If the block prints "run dg upgrade", run `dg upgrade`, then run the step again.

Run every command through it:

```bash
dg agent <command> <args>
```

If the bootstrap fails, run `dg doctor install` and retry. On Windows PowerShell, pipe the raw `bootstrap.ps1` to `Invoke-Expression`.

## Flags

| Flag | Short | Effect | Default |
|---|---|---|---|
| `--ext` | none | Same as the default, and the extension must be installed. | off (local is the default) |

To use the extension, run the gate command, then the line below it:

```text
--ext only: dg require-extension chat || exit 1
dg agent start --ext --open
```

Extension details and WSL networking for a Windows-side browser:
[references/extension.md](references/extension.md).

## Pair the browser

Run:

```bash
dg agent start
```

It prints one of two lines on stderr and nothing on stdout.

Paired:

```text
Paired <identity> (<id8>) with the browser extension.
```

Nothing more to do. Go to the loop below.

No extension:

```text
No browser extension is connected. Install it with: dg install
```

Run `dg install`, ask the human to choose **Load unpacked** once (the only human
step), then run `dg agent start` again. Every later session pairs on its own.
The human steps and the **Unpair** rule are in
[references/extension.md](references/extension.md).

## The loop

```bash
dg agent start --open              # register a session, open the chat page
dg agent progress --state running  # tell the human you are working
dg agent send "Looking at it now." # say something
dg agent progress --state awaiting-input
dg agent recv --block              # wait for their reply
dg agent close                     # finish the session
```

`recv` prints one JSON object per call and acknowledges only after printing, so
a crash mid-print re-delivers. Without `--block` it returns at once.

## Commands

- `start [-w <label>] [--orchestrator] [-a <name>] [--open] [--ext] [--print-session-id] [--json]` —
  start or reuse the daemon and register a new session. It prints the Paired
  or No-extension line on stderr and nothing on stdout. `--print-session-id` prints only the session id on stdout. `--json` prints
  `{"sessionId","port","extensionLinked"}`. `--open` opens the chat page in the
  default browser through a one-time code (single use, 60 seconds) and prints
  no URL. On WSL it does not open a browser unless `DG_OPEN_WINDOWS=1` is set.
  `--ext` gates on the extension. `-w` attaches a workset label, which groups
  sessions in the chat rail. The session token never appears in output.
- `dg daemon status` — report the live daemon's status, or that none runs.
- `recv [--block] [--timeout <ms>]` — receive the next queued message
  addressed to this session: a human reply from the chat page, or an
  agent-to-agent message for this agent's identity. The human queue comes
  first; the agent queue is read once it is empty. `--timeout` defaults to 30000 ms and applies only with `--block`.
- `send <body> [--to <identity>]` — send one complete message. Without
  `--to` it lands on the human's chat page. With `--to
  <identity>` it queues for that agent identity instead and never reaches the
  human's canvas. It waits until a session under that identity calls `recv`,
  for up to 7 days; the daemon then prunes it. That `recv` result carries
  `from` and `to`, so a reply is one more `send --to` back. The sending
  session never gets its own message back; your own identity still reaches
  your other live sessions.

  Delivery is at-least-once, not exactly-once. A message is acknowledged only
  after `recv` prints it, so a process that dies in between hands it to the
  next session under the same identity, possibly a different process. Treat a
  repeated `from`/`body` pair as a repeat, not a second instruction.
- `progress --state <running|awaiting-input>` — publish an explicit state. Any
  other value is rejected.
- `spawn [--workset <label>] [--orchestrator] [--agent-identity <name>] [-- <command...>]` —
  spawn another background chat session. Without `--`, it prints
  `{"sessionId":"<id>"}` and no token. With `--`, it runs `<command...>` with `DG_SESSION_ID` set to the new
  session and exits with the exit code of that command. Example:
  `dg agent spawn --workset review -- bun test`.
- `stage <path>` — stage an asset for later presentation and print its id. The bytes are encrypted at rest and served only to the owning session.
- `overwatch <subcommand>` — manage the shared launch board; see the `overwatch` skill.
- `close` — close the session.
- `manifest --commands <path> [--subagents <path>]` — publish the commands the
  human may run from the chat composer, and optionally the subagent names they
  may `@`-mention.
- `mcp` — serve the `dg_` Web MCP tools of the person's open browser tabs as an MCP server on stdio; no pw --ext session or agent tab group. Each call goes to the owning tab.

`-s, --session <id>` selects a session explicitly. Without it, the CLI uses
`DG_SESSION_ID`, then the sole session whose realpath-matching cwd matches
yours.

## Memory

Four verbs keep this agent's own long-term memory. The CLI opens `agents/memory.db`
in the dg state root itself, so every verb works with no daemon running at all.

- `memory write <title> [body] [--kind <kind>] [--workset <label>] [--identity <name>]` — record one memory; the body is the argument or stdin. The same title replaces the earlier memory. Prints the id. A title starting with `-` needs `--` first.
- `memory search [query] [--workset <label>] [--identity <name>] [--limit <n>] [--offset <n>] [--full]` — find memories, most relevant first; no query lists the newest. `--full` prints JSON.
- `memory read <id> [--full]` — print one memory.
- `memory forget <id>` — remove one memory.

`read` and `forget` exit 1 on a missing id. Identity comes from the session file
for this working directory, `-s <id>`, or `--identity <name>`. Full rules and
paths: [references/memory.md](references/memory.md).

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
| 78 | the dg folder layout is blocked: two used dg folders exist |

Code 5 is the one to branch on: it means "nothing arrived yet", not an error.
Loop on it. Code 6 means the human ended the conversation, so stop.

Exit code 4 sources, the `--commands` and `--subagents` manifest JSON format, and security and storage notes: [references/details.md](references/details.md).
