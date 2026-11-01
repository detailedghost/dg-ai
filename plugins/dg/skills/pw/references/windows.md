# Windows mode (`--windows`)

`dg-skills pw open --windows` starts Windows Chrome (Edge if Chrome is absent) once with PowerShell `Start-Process`. The WSL daemon then connects over CDP. Every later `dg-skills pw` command runs the same Linux code path.

```bash
dg-skills pw open --windows
dg-skills pw open --windows https://example.com
dg-skills pw open --windows --browser=msedge https://example.com
dg-skills pw close
```

## Default on WSL

Plain `dg-skills pw open` on WSL uses Windows Chrome or Edge when one exists and headless Chromium inside WSL otherwise. `--windows` forces the Windows browser. `--wsl-headed` launches a headed browser inside WSL through WSLg; use it only when the human asks.

## Requirements

- Bun >= 1.4.0 (the CDP WebSocket upgrade needs it).
- No other Chrome or Edge window on the same profile. Chrome ignores the debug port when the profile is already in use. Close that window first.
- `--windows` supports `chrome` and `msedge`. It refuses `--scratch`, `firefox`, and `webkit`.
- Profile: `C:\Users\<user>\AppData\Local\playwright-cli\profiles\<session>`. `--profile=` overrides it. The path must use printable ASCII and no double quote, or `dg-skills pw` exits 2. A profile name that only starts like another (`gh` and `gh-work`) is a different profile; `dg-skills pw` matches the whole `--user-data-dir` value.

## Files

`upload`, `state-load`, and `dg-skills pw-code --filename` read files in the WSL daemon, so `/tmp`, `/home`, and `/mnt/c` paths all work. Nothing is copied to `/mnt/c`.

## Risk

The debug port is on `127.0.0.1`, chosen at random in 20000-29999 (outside the WSL ephemeral range). While the session runs, any local process can reach that port and control the browser, including its logged-in sites. Close the session when done. Do not open sensitive sites in a Windows session you leave running.

## Other tools

`dg-skills pw attach --cdp=<url>` uses the same path for a browser you started yourself. Closing an attached session leaves the browser running.
