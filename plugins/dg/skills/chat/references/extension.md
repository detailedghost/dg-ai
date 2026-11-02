# Chat through the extension (`--ext`)

Pass `--ext` to `dg-agent start` to hand the session to the dg-ai-extension
instead of the local chat page. Gate it first:

```text
--ext only: dg-skills require-extension chat || exit 1
dg-agent start --ext --open
```

- The extension side panel connects in both directions. From the panel, **Attach CLI session** (after `dg-daemon pair`) links an already-open CLI session, and **New session for CLI** creates one that `dg-agent attach` or the next `dg-agent start` claims. From the CLI, `dg-agent start --ext --open` still hands the session to the extension.
- On WSL the daemon needs **mirrored** networking mode. NAT mode cannot reach
  the loopback port from the Windows-side browser, and the daemon exits with
  code 3 rather than pretending to be reachable.
- If the extension is waiting on exactly one session, `dg-agent start` claims
  it instead of registering another one, including when a service-installed
  daemon recorded a different directory. When several sessions are waiting,
  pass `-s <id>`.
- `dg-agent attach [-s <id>] [--open]` claims a session the extension created
  and is waiting on. Use it when Claude is already running and the side panel
  says it is waiting for an agent. A single waiting session is claimed even if
  the daemon recorded a different directory.

If a step fails, run ~/.dg/bin/dg-skills doctor require-extension install.
