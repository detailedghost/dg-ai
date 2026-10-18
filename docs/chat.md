# Chat and agent memory

Hold a **live chat with the agent in a browser tab** while it works — it can
ask you questions, show you staged files, and run commands you publish without
waking itself up:

```text
Claude Code: /dg:chat
Codex:      $dg:chat
```

The `dg-daemon` daemon hosts every session on loopback only, each gated by a
capability token, with messages and staged assets encrypted at rest. On WSL it
needs **mirrored** networking mode, since NAT cannot reach the loopback port
from the Windows-side browser.

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
