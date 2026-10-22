---
name: pw
description: Drive a browser with pw to open a site, click, fill forms, take snapshots or screenshots, scrape page data, mock requests, record video, and save logins as named states.
allowed-tools: Bash(~/.dg/bin/dg-skills pw:*), Bash(~/.dg/bin/dg-skills stash:*), Read
---

# Browser automation with pw

`pw` is a `dg-skills` subcommand on `playwright-core`, compiled into the CLI binary. It needs a Chrome-family browser: either a system Chrome/Edge/Chromium on PATH, or the Playwright-managed one (`bunx playwright-core install chromium`).

First run: install or refresh the CLI when it is missing or too old. Every later call uses the literal installed path:

```bash
~/.dg/bin/dg-skills pw --help >/dev/null 2>&1 ||
  curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.18.1/pkg/skills-cli/bootstrap.sh | sh -s -- --cli-only
```

If a step fails, run ~/.dg/bin/dg-skills doctor pw pw-code stash.

## Calling rules

- Run every step as `~/.dg/bin/dg-skills pw <command>`. Open with `pw open`.
- One command per Bash call. No `cd`, `&&`, `;`, `|`, `>` or `$( )`. Compound commands miss the `Bash(~/.dg/bin/dg-skills pw:*)` allow rule.
- Read snapshots with Read, using the `[Snapshot](...)` path `pw` prints.
- Refs look like `e13`, or `f1e1` inside a frame. They go stale after page changes. Snapshot again on "Ref not found".
- Negative numbers work as positionals: `pw mousewheel 0 -300`.

## Usage

**Usage:** `~/.dg/bin/dg-skills pw [-s=<session>] <command> [args] [options]` · `open [url] [--scratch] [--headless] [--browser=<b>] [--from=<state>] [--out=<dir>] [--depth=<n>]` · `--ext <open|click|fill|current|snapshot|screenshot|selection|console> [args]`

## Flags

| Flag | Short | Effect | Default |
|---|---|---|---|
| `-s=<name>` | none | Session name. Profile at `~/.cache/playwright-cli/profiles/<name>`. | `default`, or `PLAYWRIGHT_CLI_SESSION` |
| `--scratch` | none | In-memory profile, bound to the current directory. Long form only; bare `-s` is a usage error. | off |
| `--headless` | none | No window. | off |
| `--browser=<b>` | none | `chrome` (default), `chromium`, `msedge`, `firefox`, `webkit`. | `chrome` |
| `--from=<state>` | none | Seed the session from a saved state. | none |
| `--out=<dir>` | none | Output directory for snapshots, screenshots, and files. | `$(stash pw)/<cwd-hash>` |
| `--depth=<n>` | none | Default snapshot depth for the session (`0` means unlimited). | `6` |
| `--raw` | none | Print only the result value. | off |
| `--codegen` | none | Include the Playwright code that ran. | off |
| `--ext` | none | Drive the user's real browser through the dg-ai-extension instead of pw's own browser; only `open`, `click`, `fill`, `current`, `snapshot`, `screenshot`, `selection`, `console`. | off |
| `--help` | `-h` | Show help. | off |
| `--version` | none | Show version. | off |

## Keep context small

- The snapshot after each action uses depth 6. The printed size and line count tell you how to read it.
- Read large snapshot files with Read `offset`/`limit`, never whole.
- Scope with `pw snapshot <ref>` or `pw snapshot "#main"`. Use `--depth=N` or `--full` for one call.
- Set depth for a session with `pw open --depth=N`, or for all sessions with env `PW_SNAPSHOT_DEPTH`. Precedence: flag, then session, then env, then 6. `0` means unlimited.
- Use `pw --raw eval "..."` for one value (title, text, list of links) without a snapshot.
- `### Ran Playwright code` is off. Add `--codegen` to one command, or `pw open --codegen` for the session, when you need test code.
- `### Events` shows counts and the first 3 entries. Use `pw console` or `pw network` for the full list.
- Take screenshots only for visual checks. Images cost far more than text.
- Do not re-snapshot after every action unless the next step needs new refs.

## Quick start

```bash
~/.dg/bin/dg-skills pw open https://playwright.dev
~/.dg/bin/dg-skills pw click e15
~/.dg/bin/dg-skills pw type "page.click"
~/.dg/bin/dg-skills pw press Enter
~/.dg/bin/dg-skills pw close
```

Opening a persistent session that another directory holds is refused. Run `pw -s=<name> close` there, or pick another name.

## Output files

Snapshots, screenshots, downloads, traces, and videos land in `$(stash pw)/`. Nothing is written to the project unless you pass `--out=<dir>`. Directories that `pw` creates get mode 0700 and the files it writes get mode 0600. `pw` does not change the mode of an existing `--out` directory.
A relative `--filename` resolves against the output directory. An absolute path works anywhere.
Input files (`upload`, `state-load`, `pw-code --filename`) resolve from the client cwd. Absolute paths work, including `/tmp` and `/mnt/c`. Cap: 50 MB per upload.
Downloads save to the output directory and show as `- Downloaded <name> to <path>` under `### Events`.

## Dialogs and file choosers

A dialog stays open until you run `pw dialog-accept [text]` or `pw dialog-dismiss`. It shows under `### Modal state`. A file chooser also shows there. Run `pw upload <file...>` to answer it.

## Targets and trust

A target is a ref, a CSS selector, or a `getBy...(...)` string. `getBy` strings pass a guard that allows only locator calls, so they cannot run arbitrary code. `pw-code` runs any Node code with full access to `page` by design. It is a **separate top-level command** (`~/.dg/bin/dg-skills pw-code`, never `pw code`), so the `Bash(~/.dg/bin/dg-skills pw:*)` allow rule does not cover it: Claude Code asks for your approval on every `pw-code` call. Do not add `pw-code` to `allowed-tools` or to an allow rule. `pw eval` runs JavaScript in the page. Only run code you wrote or checked.

## Logins

`pw state save <name>` stores a login under `$(stash -s -G pw states)/` (0700 directory, 0600 files). Prefer it over raw `pw state-save <file>`, which leaves a full cookie jar in a plain file until you delete it. `pw open --from=<name>` or `pw state load <name>` reuses it. Details in `references/session-management.md`.

## Driving the user's real browser with --ext

`~/.dg/bin/dg-skills pw --ext <verb> [args]` drives the browser the user is actually looking at, through the dg-ai-extension, instead of a browser pw starts and owns. It covers eight verbs: write verbs `open`, `click`, `fill`; read verbs `current` (active tab URL and title plus open tabs), `snapshot` (same shape as plain `pw snapshot`, on stdout), `screenshot` (saved to scratch, path printed), `selection` (selected text), and `console` (recent errors and warnings). There is no `--ext eval` and no `--ext run-code`.

Every call asks the user once, naming the tab; a denial exits non-zero. Output is redacted (password fields, token-like values) and size-capped. Browser settings pages (`chrome://`, `about:`, `chrome-extension://`, and similar) are refused before any request reaches the extension. `--ext` only works with a Chromium-family browser.

This repo ships the CLI side of `--ext` and its message contract, tested with a fake transport. The extension-side handler, the dg-daemon frame that carries the request, and the user-facing approval prompt are not wired up yet; see `references/ext-mode.md`.

## Dropped commands

`pause-at`, `resume`, `step-over`, `show`, `tray`, and `attach <name>` are gone. Legacy `playwright-cli attach` covers them. To add them back, see "Extending" in `references/commands.md`.

## References

| Need | File |
|---|---|
| Commands, raw output, snapshots, targeting, extending | `references/commands.md` |
| Windows mode, CDP, risks | `references/windows.md` |
| Sessions, profiles, named states, logins | `references/session-management.md` |
| Playwright tests, test generation | `references/test-generation.md` |
| Request mocking | `references/request-mocking.md` |
| `pw-code` recipes and approval | `references/running-code.md` |
| Cookies, storage, state files | `references/storage-state.md` |
| Tracing | `references/tracing.md` |
| Video recording, light/dark screenshot pairs | `references/video-recording.md` |
| `--ext` contract and what is not built yet | `references/ext-mode.md` |
