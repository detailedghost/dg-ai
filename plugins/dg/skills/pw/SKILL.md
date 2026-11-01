---
name: pw
description: Drive a browser with pw to open a site, click, fill forms, take snapshots or screenshots, scrape page data, mock requests, record video, and save logins as named states.
---

# Browser automation with pw

First run: install or refresh the CLI when it is missing or too old. Every later call uses the literal installed path:

```bash
~/.dg/bin/dg-skills pw --help >/dev/null 2>&1 ||
  curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh -s -- --cli-only
```

If a step fails, run ~/.dg/bin/dg-skills doctor pw pw-code stash.

`/dg:pw` drives a browser through `playwright-core`. It needs Bun >= 1.4.0 and Google Chrome or Microsoft Edge. Below, `pw <command>` means `~/.dg/bin/dg-skills pw <command>`.

## Calling rules

- Run every step as `~/.dg/bin/dg-skills pw <command>`. Open with `pw open`.
- One command per Bash call. No `cd`, `&&`, `;`, `|`, `>` or `$( )`. Compound commands miss the allow rule.
- Read snapshots with Read, using the `[Snapshot](...)` path the command prints.
- Refs look like `e13`, or `f1e1` inside a frame. They go stale after page changes. Snapshot again on "Ref not found".

## Keep context small

- The snapshot after each action uses depth 6. The printed size and line count tell you how to read it.
- Read large snapshot files with Read `offset` and `limit`, never whole.
- Scope with `pw snapshot <ref>` or `pw snapshot "#main"`. Use `--depth=N` or `--full` for one call.
- Set depth for a session with `pw open --depth=N`, or for all sessions with env `PW_SNAPSHOT_DEPTH`. `0` means unlimited.
- Use `pw --raw eval "..."` for one value without a snapshot.
- Take screenshots only for visual checks. Images cost far more than text.

## Browser

`pw open` uses a system Chrome, then Edge, then a Chromium that `install-browser` downloaded. With none, it exits 3.
Ask the human before you run `~/.dg/bin/dg-skills pw install-browser`: it downloads about 150 MB under the dg data directory.
Tell the human that `install-browser --remove` deletes the download.

## WSL

On WSL, `pw open` drives Windows Chrome or Edge over CDP when one exists, and headless Chromium inside WSL otherwise. `pw open --windows` forces the Windows browser.
Agents never pass `--wsl-headed` unless the human asks. Never launch a headed browser on WSL: the window needs WSLg and is experimental. Details in `references/windows.md`.

## Quick start

```bash
~/.dg/bin/dg-skills pw open https://playwright.dev
~/.dg/bin/dg-skills pw click e15
~/.dg/bin/dg-skills pw close
```

## Open flags

| Flag | Effect |
|---|---|
| `-s=<name>` | Session name. Persistent sessions are global by name. |
| `--scratch` | In-memory profile, bound to the current directory. |
| `--headless` | No window. |
| `--browser=<b>` | `chrome`, `chromium`, `msedge`, `firefox`, `webkit`. |
| `--profile=<dir>` | Profile directory. Use only when asked. |
| `--from=<state>` | Seed from a saved state. See `references/session-management.md`. |
| `--out=<dir>` | Output directory, for example a project folder. |
| `--depth=<n>` | Snapshot depth for this session. |

Opening a persistent session that another directory holds is refused. Close it there, or pick another name.

## Output and logins

Snapshots, screenshots, downloads, traces, and videos land in `~/.dg/bin/dg-skills stash pw`. Nothing goes to the project unless you pass `--out=<dir>`.
`pw state save <name>` stores a login in a private directory. Prefer it over `pw state-save <file>`, which leaves a full cookie jar in a plain file.

## Security

A target is a ref, a CSS selector, or a `getBy...(...)` string. `getBy` strings pass a guard that allows only locator calls. `pw eval` runs JavaScript in the page, so run only code you wrote or checked.
`~/.dg/bin/dg-skills pw-code` runs any Node code with full access to the page. It is a separate command so the pw allow rule does not cover it: Claude Code asks the human to approve every call. Never add pw-code to an allow rule or to `allowed-tools`.

## References

| Need | File |
|---|---|
| Commands, raw output, snapshots, targeting | `references/commands.md` |
| Windows mode, CDP, risks | `references/windows.md` |
| Sessions, profiles, named states | `references/session-management.md` |
| Tests and request mocking | `references/test-generation.md`, `references/request-mocking.md` |
| `pw-code` recipes and approval | `references/running-code.md` |
| Cookies, storage, state files | `references/storage-state.md` |
| Tracing and video | `references/tracing.md`, `references/video-recording.md` |
