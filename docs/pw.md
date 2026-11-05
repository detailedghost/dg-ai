# Pw browser skill

`dg-skills pw` drives a browser through `playwright-core`: open a page, click,
fill, snapshot, screenshot, mock requests, record video, and save logins as
named states. `dg-skills pw-code` runs arbitrary Node code against the page. The
skill is `plugins/dg/skills/pw/SKILL.md`.

## Browser

`pw open` picks a system Chrome, then Edge, then a Chromium that
`dg-skills pw install-browser` downloaded. With none, it exits 3. The skill tells
agents to ask first, because the download is about 150 MB.
`dg-skills pw install-browser --remove` deletes it. See
[install](install.md#browser-download-for-pw).

## WSL

On WSL, `pw open` uses Windows Chrome or Edge over CDP when one exists, and
headless Chromium inside WSL otherwise. `--windows` forces the Windows browser.
`--wsl-headed` opens a headed browser through WSLg and is experimental. Agents
never pass it unless the human asks.

## Real browser (`--ext`)

`dg-skills pw --ext <verb>` acts on the active tab of your real Chromium
browser through the paired dg-ai-extension. It needs a running dg-daemon
session with the extension paired. The extension must be at least the version
in `PW_EXT_MIN_EXTENSION_VERSION` (`pkg/common/src/pw-ext-format.ts`), which is
the release that ships `pw --ext`.

| Verb | Kind | Effect |
|---|---|---|
| `current` | read | Active tab URL and title, plus the open tabs |
| `snapshot` | read | Accessibility tree with refs, and the visible text, on stdout |
| `screenshot` | read | Visible part of the tab, saved to `dg-skills stash pw` |
| `selection` | read | Selected text |
| `console` | read | Errors, and console warnings and errors after the first call |
| `tools` | read | WebMCP tools the page exposes: name, description, input schema |
| `open <url>` | write | Opens an http or https URL in a new tab |
| `click <ref or selector>` | write | Clicks one element |
| `fill <ref or selector> <text>` | write | Sets the value of one text field |
| `upload <ref or selector> <file>` | write | Sets one file on a file input |
| `call <tool> <json-args>` | write | Runs one WebMCP tool of the page |

Rules:

- The browser opens a small approval window for every call. It names the verb
  and the tab. Write verbs say that they change the page. Close the window or
  click Deny to refuse. The CLI cannot approve.
- Before the window opens, `click`, `fill` and `upload` read only their target
  element (tag, role, accessible name, short text) and show it. A target that
  does not resolve is refused with no prompt. `call` reads the page's tool list
  first and shows the tool name, description, hints and the exact args.
- After approval, the extension checks that the tab did not change, and the
  page function checks the document URL again before it acts. A write also
  checks that it acts on the same element the approval showed. If any of
  these changed, nothing runs. A reload at the same URL is not detected.
- Browser settings pages (`chrome://`, `edge://`, `brave://`, `about:`),
  extension pages, `file:` pages, the web stores, private windows, and the
  signed-in Proton Mail tab are refused before any prompt. `current` still runs
  and shows those tabs without their URL or title. `open` still runs and opens a
  new tab.
- Text output is redacted (tokens, keys, emails, secret query values) and
  capped. Password and secret field contents are left out, and `fill` refuses
  those fields. Screenshots are not redacted: they show what is on the screen.
- If the dg session closes, or the CLI stops (Ctrl-C, SIGTERM or a closed
  socket), the request is canceled and the approval window closes.
- There is no code execution of agent code: no `eval`, no `run-code`, and no
  other pw flags. `call` runs the site's own WebMCP tool code, so it is a write
  verb.
- `console` adds a small wrapper to the page's own `console.warn` and
  `console.error` on the first call. It runs in the page's own context, stays
  for the life of the document, and sees only messages after that first call.
  Uncaught errors and unhandled rejections are captured from the same point.
- `upload` takes a regular file of at most 25 MiB from the working directory,
  the dg scratch directory or the dg demos directory, never from the home
  folder itself. It refuses hidden files and folders, a file that is a symbolic
  link, folders, and a file that changes while it is checked. The CLI stages the bytes in the local dg-daemon asset store
  before the approval; the extension fetches them only after approval, and only
  to an `https:` page. The approval shows the path, name, size, type,
  destination origin and the target element. The staged copy is deleted as
  soon as the extension fetches it, and also when the request is denied,
  canceled, times out or fails.
- `tools` uses the WebMCP `document.modelContext` API, or the older
  `navigator.modelContextTesting` preview. With neither, it prints "This page
  exposes no WebMCP tools." Tool discovery and a tool call each have a timeout;
  the site's own tool code can keep running after it.
- `click` and `fill` send synthetic events. A page that checks for trusted
  input ignores them.
- Firefox is not supported.

See [ADR 0035](adr/0035-pw-ext-real-browser.md).

## Security

`pw-code` is a separate command so the `pw` allow rule does not cover it. Claude
asks for approval on every call. `dg-skills doctor pw-code` warns when
`Bash(dg-skills pw-code:*)` or the `Bash(dg-skills:*)`
wildcard sits in `~/.claude/settings.json`.

## Check the setup

```sh
dg-skills doctor pw pw-code
```

`dg-skills doctor pw` also reports the extension pairing for `--ext`, as
information only.

## Remove the old ~/scripts copy

After one `dg-skills install`, remove the pre-port copy:

1. Run `~/scripts/bin/pw kill-all` to stop old daemons.
2. Delete `~/scripts/bin/pw`, `~/scripts/bin/pw-daemon`, and `~/scripts/bin/pw-code`.
3. Delete `~/scripts/ai/skills/pw/`. Remove the `pw`, `pw-daemon`, and `pw-code`
   entries from `TOOLS` in `~/scripts/ai/build.ts`, then rebuild.
4. Delete `~/.codex/skills/pw` and `~/.config/opencode/skills/pw`.
   `dg-skills install --skills-only --dest <dir>` installs the plugin copy.
5. Replace `Bash(pw:*)` in `~/.claude/settings.json` with
   `Bash(dg-skills pw:*)`. Keep `Bash(playwright-cli *)` only if the
   legacy tool stays.
6. Optional: `~/.cache/playwright-cli/profiles` holds saved logins and stays
   valid. Delete it only to start clean.
