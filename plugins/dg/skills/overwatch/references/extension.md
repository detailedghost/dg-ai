# Overwatch through the extension (`--ext`)

Pass `--ext` to `dg-agent overwatch open` to open `/board` in the paired
browser through the dg-ai-extension instead of the default browser. Gate it first:

```text
--ext only: dg-skills require-extension overwatch || exit 1
dg-agent overwatch open --ext
```

The daemon sends the open request to the extension, which opens or focuses the
daemon's `/board` page in the paired browser, so the extension must be paired
and connected. The command fails with the daemon's message when
no extension is connected.

On WSL the daemon needs **mirrored** networking mode. NAT mode cannot reach the
loopback port from a Windows-side browser, and the daemon exits with code 3
rather than pretending to be reachable.
