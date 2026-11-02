# Overwatch through the extension (`--ext`)

Pass `--ext` to `dg-agent overwatch open` to focus the board in the
dg-ai-extension instead of opening the local page. Gate it first:

```text
--ext only: dg-skills require-extension overwatch || exit 1
dg-agent overwatch open --ext
```

The daemon sends the open request to the extension side panel, so the extension
must be paired and connected. The command fails with the daemon's message when
no extension is connected.

On WSL the daemon needs **mirrored** networking mode. NAT mode cannot reach the
loopback port from a Windows-side browser, and the daemon exits with code 3
rather than pretending to be reachable.
