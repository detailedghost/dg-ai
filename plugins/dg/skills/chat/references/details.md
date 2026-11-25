# Chat manifest, delivery and storage details

Moved out of SKILL.md. Exit code 4 first, then the manifest format, then notes.

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
- The dg state root (`~/.local/state/dg` on Linux; `resolveDgPaths` gives the other OSes)
  is two independent trees: `daemon/` holds the encrypted `daemon.db`
  that stores those messages and assets, and `agents/` holds session files
  plus the plain-text `memory.db` behind `memory` — plain text on purpose,
  since FTS5 cannot index ciphertext.
- Chat sessions live in the daemon database, not as files under `agents/sessions`. Existing session files are imported on startup and then removed. Once an agent has claimed a session, `send`, `progress`, and `recv` may come and go. A gap between those commands does not reap the session or mark the agent gone. The claim is released only after a long quiet period with no CLI command, and the session is then archived even if the chat page is still open. Extension keepalives do not keep a released claim alive. A background pass trims the archive and the message rows that belonged to it, and checkpoints the database. `dg daemon sessions clear` archives sessions whose claim has been released. Sessions whose claim is held between commands are left alone.
- `dg install` refreshes the one `dg` binary, so re-running it keeps the agent
  and the daemon current.
