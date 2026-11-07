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
On WSL these commands print the URL and do not start a Windows browser. Set
`DG_OPEN_WINDOWS=1` to open the Windows default browser.

The URL ends in a fragment, `#_chat=<base64url>`, that carries the session
token. The browser never sends a fragment to a server, so the token stays out
of the page request. The page then sends it as a Bearer header on fetch and
as the `token` query on the WebSocket upgrade. The page reads it, removes it from the address bar,
and keeps it in `sessionStorage` for that tab. The page shells are public. The
data routes accept a request only from a loopback `Origin` or no `Origin`, and
only with the token of a live session. A dead token gets 403 and a foreign
origin gets 400.

The `dg-daemon` daemon hosts every session on loopback only, each gated by a
capability token, with messages and staged assets encrypted at rest. On WSL it
needs **mirrored** networking mode, since NAT cannot reach the loopback port
from the Windows-side browser.

Pass `--ext` to `dg-agent start` or `dg-agent overwatch open` to require the
dg-ai-extension. `dg-agent start --ext` prints the local `/chat` URL, and `--open`
opens it. `dg-agent overwatch open --ext` makes the paired browser open `/board`.
That command has no `--open` flag. The human reads the six-digit code in the
extension's pairing popup. The agent runs `dg-agent pair <code>`. See
[ADR 0031](adr/0031-loopback-pages.md) and [ADR 0038](adr/0038-extension-pairing-only.md).

Upgrading from a release without the pairing popup? Read
[the upgrade section](AGENT-INSTALL.md#upgrading-from-a-release-without-the-pairing-popup).

An agent can also address another agent directly — `dg-agent send --to <identity>`
queues a message for that identity instead of the human, and the recipient's
`recv` names both sides in `from` and `to`. Each agent keeps its own long-term
memory in a separate, plain-text, full-text-searchable `~/.dg/agents/memory.db`,
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
