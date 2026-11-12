# Chat and agent memory

Hold a **live chat with the agent in a browser tab** while it works — it can
ask you questions, show you staged files, and run commands you publish without
waking itself up:

```text
Claude Code: /dg:chat
Codex:      $dg:chat
```

`dg-agent start --open` opens the chat page that `dg-daemon` serves at
`http://127.0.0.1:<port>/chat`. No extension is needed. The same daemon serves
the overwatch board at `/board`, and `dg-agent overwatch open` opens it.
On WSL these commands do not start a Windows browser. Set
`DG_OPEN_WINDOWS=1` to open the Windows default browser.

No command prints a URL, and no URL carries the session token. `--open` and
`overwatch open` ask the daemon for a one-time code and open
`/chat#_chatcode=<code>` or `/board#_chatcode=<code>`. The code works once,
within 60 seconds. The page removes the code from the address bar, trades it
for the session bootstrap, and keeps the bootstrap in `sessionStorage` for that
tab. The page then sends the token as a Bearer header on fetch and as the
`token` query on the WebSocket upgrade. The page shells are public. The data
routes accept a request only from a loopback `Origin` or no `Origin`, and only
with the token of a live session. A dead token gets 403 and a foreign origin
gets 400.

The `dg-daemon` daemon hosts every session on loopback only, each gated by a
capability token, with messages and staged assets encrypted at rest. On WSL it
needs **mirrored** networking mode, since NAT cannot reach the loopback port
from the Windows-side browser.

Pairing the browser needs no code. Run `dg-agent start`. It prints
`Paired <identity> (<id8>) with the browser extension.` on stderr, or
`No browser extension is connected. Install it with: dg-skills install`. In the
second case, run `dg-skills install` and ask the human to load the extension
once with **Load unpacked**. That is the only routine human step. Pass `--ext`
to `dg-agent start` or `dg-agent overwatch open` to require the extension.
`dg-agent overwatch open --ext` makes the paired browser open `/board`. That
command has no `--open` flag.

`dg-agent spawn -- <command...>` creates a session and runs the command with
`DG_SESSION_ID` set. It exits with the exit code of that command. The CLI picks
its session from `--session`, then `DG_SESSION_ID`, then the one session for
the current directory.

The daemon trusts any process of the same user on this machine, without a
prompt. See [ADR 0031](adr/0031-loopback-pages.md) and
[ADR 0039](adr/0039-zero-touch-pairing.md).

Upgrading from a release without the pairing popup? Read
[the upgrade section](AGENT-INSTALL.md#upgrading-from-a-release-without-the-pairing-popup).

An agent can also address another agent directly — `dg-agent send --to <identity>`
queues a message for that identity instead of the human, and the recipient's
`recv` names both sides in `from` and `to`. Each agent keeps its own long-term
memory in a separate, plain-text, full-text-searchable `agents/memory.db` in the dg state root
(`~/.local/state/dg/agents/memory.db` on Linux; `resolveDgPaths` gives the other OSes),
which four `dg-agent memory` verbs (`write`, `search`, `read`, `forget`) read and
write with no daemon running at all.

## Credential store

`dg-skills credentials set|list|delete` keeps secrets encrypted in
dg-daemon's `credentials.db`. `set` reads the value from stdin or a hidden
prompt, and no command prints it. `grant|revoke` manage read-only service
tokens. Start a session with `dg-agent start` first. See the
[developer guide](DEVELOPER.md#credential-store).

See the [chat skill](../plugins/dg/skills/chat/SKILL.md) for commands and the
[security records](adr/toc.md#security) for storage and session boundaries.
