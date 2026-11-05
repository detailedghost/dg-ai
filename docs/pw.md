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
session with the extension paired, and dg-ai-extension 1.41.0 or newer.

| Verb | Kind | Effect |
|---|---|---|
| `current` | read | Active tab URL and title, plus the open tabs |
| `snapshot` | read | Accessibility tree with refs, and the visible text, on stdout |
| `screenshot` | read | Visible part of the tab, saved to `dg-skills stash pw` |
| `selection` | read | Selected text |
| `console` | read | Uncaught errors and unhandled rejections |
| `open <url>` | write | Opens an http or https URL in a new tab |
| `click <ref or selector>` | write | Clicks one element |
| `fill <ref or selector> <text>` | write | Sets the value of one text field |

Rules:

- The browser opens a small approval window for every call. It names the verb
  and the tab. Write verbs say that they change the page. Close the window or
  click Deny to refuse. The CLI cannot approve.
- After approval, the extension checks that the tab did not change, and the
  page function checks the document URL again before it acts. If either
  changed, nothing runs. A reload at the same URL is not detected.
- Browser settings pages (`chrome://`, `edge://`, `brave://`, `about:`),
  extension pages, `file:` pages, the web stores, private windows, and the
  signed-in Proton Mail tab are refused before any prompt. `current` still runs
  and shows those tabs without their URL or title. `open` still runs and opens a
  new tab.
- Text output is redacted (tokens, keys, emails, secret query values) and
  capped. Password and secret field contents are left out, and `fill` refuses
  those fields. Screenshots are not redacted: they show what is on the screen.
- If the dg session closes while the approval window is open, the request is
  canceled and the window closes.
- There is no code execution: no `eval`, no `run-code`, and no other pw flags.
- `console` starts capture on the first call for a tab. It shows errors after
  that point, not `console.warn` output and not earlier errors.
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
