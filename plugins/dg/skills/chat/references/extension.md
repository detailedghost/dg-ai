# Chat through the extension (`--ext`)

Pass `--ext` to `dg-agent start` to open the local chat page and pair the
browser from the DeeGee popup with `dg-agent pair <code>`. Gate it first:

```text
--ext only: dg-skills require-extension chat || exit 1
dg-agent start --ext --open
```

- `dg-agent start --ext --open` opens the daemon's local chat page exactly like `--open`; the extension is not involved. To pair the browser, open the DeeGee popup, read its six-digit code and run `dg-agent pair <code>` from the session.
- On WSL the daemon needs **mirrored** networking mode. NAT mode cannot reach
  the loopback port from the Windows-side browser, and the daemon exits with
  code 3 rather than pretending to be reachable.
- If the extension is waiting on exactly one session, `dg-agent start` claims
  it instead of registering another one, including when a service-installed
  daemon recorded a different directory. When several sessions are waiting,
  pass `-s <id>`.
- `dg-agent attach [-s <id>] [--open]` claims a session the extension created
  and is waiting on. On WSL, `--open` prints the URL unless `DG_OPEN_WINDOWS=1`
  is set. Use it when Claude is already running and the browser is waiting for
  an agent. A single waiting session is claimed even if
  the daemon recorded a different directory.

If a step fails, run dg-skills doctor require-extension install.
