---
name: pw
description: Drive a browser with pw to open a site, click, fill forms, take snapshots or screenshots, scrape page data, mock requests, record video, and save logins as named states.
---

# Browser automation with pw

First run: the block installs the CLI when it is missing. It prints an upgrade hint when the CLI is too old.

```bash
dg pw --help >/dev/null 2>&1 ||
  "${DG_HOME:-$HOME/.local}/bin/dg" pw --help >/dev/null 2>&1 ||
  { { dg --version >/dev/null 2>&1 || "${DG_HOME:-$HOME/.local}/bin/dg" --version >/dev/null 2>&1; } && echo "run dg upgrade"; } ||
  curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh -s -- --cli-only
```

Call `dg` in every later step. If `dg` alone does not answer, also after the bootstrap, call `${DG_HOME:-$HOME/.local}/bin/dg` instead. If the block prints "run dg upgrade", run `dg upgrade`, then run the step again.

If a step fails, run dg doctor pw pw-code batch-open launch install stash credentials.

`/dg:pw` drives a browser through `playwright-core`. It needs Bun >= 1.4.0 and Google Chrome or Microsoft Edge. Below, `pw <command>` means `dg pw <command>`.

**Usage:** `dg pw [--ext|--local] <command> [args]`

## Flags

| Flag | Short | Effect | Default |
|---|---|---|---|
| `--ext` | | Force the human's real browser through the paired dg-ai-extension. See "Real browser". | off; `auto` mode uses a paired extension without it |
| `--local` | | Force the Playwright browser that dg starts. | off |

## Calling rules

- Run every step as `dg pw <command>`. Open with `pw open`.
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

`pw open` finds a browser: `DG_VERIFY_BROWSER` (a binary path), then Chrome, Edge, other Chromium-family browsers, then a downloaded Chromium. Ask the human before you run `dg pw install-browser`: it downloads about 150 MB, and `install-browser --remove` deletes it. Search order and fallbacks: `references/browser-finder.md`.

## WSL

On WSL, `pw open` drives Windows Chrome or Edge over CDP when one exists, and headless Chromium inside WSL otherwise. `pw open --windows` forces the Windows browser.
Agents never pass `--wsl-headed` unless the human asks. Without that request, never launch a headed browser on WSL: the window needs WSLg and is experimental. Details in `references/windows.md`.

## Quick start

```bash
dg pw open https://playwright.dev
dg pw click e15
dg pw close
```

## Open flags

`-s=<name>` names a session, `--scratch` uses an in-memory profile, `--headless` hides the window, `--browser=<b>` picks `chrome`, `chromium`, `msedge`, `firefox` or `webkit`, `--from=<state>` seeds from a saved state, `--out=<dir>` sets the output directory, `--depth=<n>` sets snapshot depth. Use `--profile=<dir>` only when asked. Every flag, with its detail: `references/commands.md`.

Opening a persistent session that another directory holds is refused. Close it there, or pick another name.

## Output and logins

Snapshots, screenshots, downloads, traces, and videos land in `dg stash pw`. Nothing goes to the project unless you pass `--out=<dir>`.
`pw state save <name>` stores a login in a private directory. Prefer it over `pw state-save <file>`, which leaves a full cookie jar in a plain file.

## Browser mode

The default is `auto`. A call goes to the human's real browser through the extension only when the extension is paired and connected, the verb has an ext verb, and the call has no options and no session. Every other call runs in a local Playwright browser. `--ext` and `--local` force one. `DG_BROWSER=ext|local` and `browser.mode` in `config.toml` (`ext`, `local`, `auto`) force it for a shell or for good.
Some verbs run local in every mode: `route`, `unroute`, `route-list`, `network-state-set`, `state-save`, `state-load`, `delete-data`, `cookie-set`, `cookie-delete`, `cookie-clear`, `video-*`, `tracing-*`, `pdf`, `install-browser`, `kill-all`, `attach`. `--ext` with one of them exits 2. The reason for each verb, and the auto routing rules: `references/browser-mode.md`.
`pw select`, `close`, `tab-select`, `upload` and `tab-close <index>` also stay local in auto mode. Their ext verbs take different arguments.

## Real browser (`--ext`)

Use ext only when the human asks you to look at or act on a page in their real browser. Plain `--local` stays right for tests, recording, mocking and isolated runs.
Each session gets its own agent window and tab group. You act only on tabs in that group, until the human hands you one from the extension popup.
The browser asks the human once per site in a session. A PHI checkbox on that popup makes `snapshot` and `screenshot` refuse the site. `eval` and the storage write verbs never ask: they refuse a site that is not allowed yet, so navigate or read first. A Stop click on the page ends your control, so act only on what the human asked for.
`tools` and `call` are the Web MCP bridge and use Web MCP approvals, not the site question. To save tokens, run `pw --ext tools` first and prefer a WebMCP tool; else use refs from one snapshot. Verbs, tabs, refs, uploads and blocked pages: `references/real-browser.md`.

## Tab batches

`pw batch-open [--ext] [-g <name>] [-R owner/repo] [--print] <refs>` opens PR or URL tabs in the default browser, grouped only with `--ext`. `pw --ext launch [-b <key>] [-g <name>] [--list] [--dry-run] <refs>` cold-starts Chromium with the extension side-loaded. Refs, markers and the extension install: `references/tabs.md`.

## Security

A target is a ref, a CSS selector, or a `getBy...(...)` string. `getBy` strings pass a guard that allows only locator calls. `pw eval` runs JavaScript in the page, so run only code you wrote or checked.
`dg pw-code` runs any Node code with full access to the page. It is a separate command so the pw allow rule does not cover it: Claude Code asks the human to approve every call. Never add pw-code to an allow rule or to `allowed-tools`.

## References

| Need | File |
|---|---|
| Commands, raw output, snapshots, targeting | `references/commands.md` |
| Windows mode, CDP, risks | `references/windows.md` |
| Browser search order, `--browser` fallbacks | `references/browser-finder.md` |
| Sessions, profiles, named states | `references/session-management.md` |
| Tests and request mocking | `references/test-generation.md`, `references/request-mocking.md` |
| `pw-code` recipes and approval | `references/running-code.md` |
| Cookies, storage, state files | `references/storage-state.md` |
| Tracing and video | `references/tracing.md`, `references/video-recording.md` |
| Auto mode, local-only verbs and reasons | `references/browser-mode.md` |
| Real browser with `--ext` | `references/real-browser.md` |
| Tab batches, refs, extension install | `references/tabs.md` |
