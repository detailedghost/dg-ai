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

`dg-skills pw --ext <verb>` acts on the agent's selected tab in your real
Chromium browser through the paired dg-ai-extension. It needs a running
dg-daemon session with the extension paired. The extension must be at least the
version in `PW_EXT_MIN_EXTENSION_VERSION` (`pkg/common/src/pw-ext-format.ts`),
which is the first release with per-agent tab groups. An older extension is
refused with the update text: `pw --ext requires dg-ai-extension <version> or
newer; update the extension, reload it, and reconnect this session.`

Each paired agent gets its own Chrome tab group, titled with the agent name and
the first four characters of its session id. The agent sees and acts only on
tabs in its own group. To give an agent one of your tabs, use the extension
popup.

| Verb | Kind | Effect |
|---|---|---|
| `current` | read | URL and title of the agent's selected tab |
| `tabs` | read | The tabs in the agent's group, the selected one marked |
| `snapshot` | read | Accessibility tree with refs, and the visible text, on stdout |
| `screenshot` | read | Visible part of the tab, saved to `dg-skills stash pw`; brings the tab to the front first |
| `selection` | read | Selected text |
| `console` | read | Errors, and console warnings and errors after the first call |
| `tools` | read | WebMCP tools the page exposes: name, description, input schema |
| `count <ref or selector>` | read | How many elements match, with tag, type, id and name for each. Test a selector with it before `click`, `fill` or `upload` |
| `open <url>` | write | Opens an http or https URL in the selected tab, or in a new tab when the agent has none |
| `new [url]` | write | Opens a new tab in the agent's group and selects it; with no URL it opens a blank tab |
| `select <tabId>` | write | Makes a tab of the group the selected tab |
| `close [tabId]` | write | Closes a tab of the group; the selected tab by default |
| `click <ref or selector>` | write | Clicks one element |
| `fill <ref or selector> <text>` | write | Sets one text field, or a date or time field (`date` as `YYYY-MM-DD`, `time` as `HH:MM`, plus `datetime-local`, `month` and `week`), or picks one `<select>` option by value, then label, then case-insensitive label. A multi-select is refused |
| `fill <ref or selector> --value-env NAME` | write | Sets a password or secret field from the CLI environment variable `NAME`. Needs `unmask` |
| `fill <ref or selector> --value-stdin` | write | Same, but reads the value from stdin. Needs `unmask` |
| `unmask [--minutes N]` | write | Asks you for a time-boxed unmask of the selected tab's origin. `N` is 1 to 60, default 15. `unmask --off` ends it |
| `upload <ref or selector> <file>` | write | Sets one file on a file input |
| `call <tool> <json-args>` | write | Runs one WebMCP tool of the page |
| `dialog` | write | Shows the page's last `alert`, `confirm` or `prompt`, how it was answered, and the answer set for the next one |
| `dialog accept [--text <answer>]` | write | Accepts the next dialog on the page. `--text` is the answer a `prompt` gets |
| `dialog dismiss` | write | Dismisses the next dialog on the page. Each new page starts at dismiss |

Rules:

- Passing `--ext` gives the CLI the agent's tab group. The first verb on a new
  site in a session, `open` and `new` too, opens a small extension popup that
  asks you to allow that site for the session. Reads and writes both need it.
  Deny, no answer in 60 seconds, or a closed window allows nothing, and no page
  is touched. Allowed sites live in `storage.session` and go away when the
  session ends. `tabs`, `select` and `close` ask nothing. Mailbox origins keep
  their guard.
- Each agent tab shows an "Agent is driving this tab" banner with a Stop button.
  The banner sits in a closed shadow root in the extension's own script world.
  Stop ends that session's control at once: verbs in flight fail, unmask and
  `dg_` grants and allowed sites go away, the tab group returns to you, and
  each later verb fails with an error that names Stop until a new dg session
  starts. Only a real click counts; a page script cannot press it.
- Each dg session has its own tab group. The CLI picks the session from
  `--session <id>`, then the `DG_SESSION_ID` environment variable, then the one
  session registered for the working directory. Under `--ext`, `--session` takes
  a dg session id, not a pw browser session name.
- Every verb acts on the agent's selected tab. `--tab <id>` targets one tab of
  the group once and does not change the selection. `tabs`, `new` and `select`
  take no `--tab`. `close` takes a tab id or `--tab`, not both.
- A tab outside the agent's group is refused. If you close the selected tab or
  drag it out of the group, the agent is told to run `pw --ext tabs` and then
  `pw --ext select <id>`. A group holds at most 200 tabs.
- `screenshot` brings the tab to the front, captures it, and leaves it in front.
  It also restores a minimized window.
- The page function checks the document URL against the tab URL before it
  acts. If the page changed, nothing runs. A reload at the same URL is not
  detected.
- Browser settings pages (`chrome://`, `edge://`, `brave://`, `about:`),
  extension pages, `file:` pages, the web stores, private windows, and the
  signed-in Proton Mail tab are refused. `tabs`, `new` and `close` still run
  when the selected tab is one of them, and `tabs` shows those tabs without their
  URL or title. `open` navigates a settings page to a web page. The Proton Mail
  tab is never read, closed or navigated.
- Text output is redacted (tokens, keys, emails, secret query values) and
  capped. Password and secret field contents are left out, and `fill` refuses
  those fields unless an unmask grant holds. Screenshots are not redacted: they
  show what is on the screen.
- `unmask` asks you, in a small extension popup window, to let the agent see
  real email addresses on one site. The popup shows the session, the origin,
  what the grant allows and the duration. It has Allow and Deny, and no button
  has focus. Deny, no answer in 60 seconds, a closed window, or a window that
  cannot open grants nothing, and the reply says which occurred. Only your click
  in that window grants. The agent cannot grant itself.
- While a grant holds, on that origin only and in that session's agent tab group
  only, email addresses show unmasked and `fill` may set a password or
  secret field. Tokens, API keys, JWTs and `password=` values stay masked.
- The grant ends at its time, on `unmask --off`, or when the tab group changes
  or closes. It never covers a mailbox origin or a browser-internal page. An
  extension that does not list `unmask` in its `pwExtVerbs` handshake refuses the
  verb at once.
- Each page reply under a grant starts with `### Unmask`, then
  `unmasked on <origin> until HH:MM (approved in the browser)`.
- A secret value never goes in argv. Use `fill <target> --value-env NAME` or
  `--value-stdin`. The value must have at least 4 characters. It is removed from
  all output, and the result says only `filled <field>`. Without a grant, the
  refusal names `pw --ext unmask`.
- If the dg session closes, or the CLI stops (Ctrl-C, SIGTERM or a closed
  socket), the request is canceled and nothing more runs.
- There is no code execution of agent code: no `eval`, no `run-code`, and no
  pw flags besides `--tab`. `call` runs the site's own WebMCP tool code, so it
  is a write verb.
- A page dialog never blocks a verb. When an agent tab starts to load, the
  extension puts a small shim over `alert`, `confirm` and `prompt` in that page.
  The shim answers each dialog at once: dismiss by default, or the one answer
  that `dialog accept` or `dialog dismiss` set. It keeps the last 10 dialogs.
  `dialog` shows the last one, and `snapshot` lists the ones not yet shown under
  `### Dialog`. Dialog text is page content and is redacted like other output.
  The shim never runs in a user tab, on a mailbox origin or on a browser page.
  When a tab leaves the agent's group or the session ends, the shim goes away,
  and that page keeps its native dialogs until it navigates.
  A dialog that opens while a page loads, before the shim is in place, shows
  in the browser as usual. A verb then stops after 15 seconds with an error
  that asks you to close the dialog. The page can read the answer text that
  `--text` sets, so `dialog accept --text` refuses a value the session filled
  as a secret. An extension that does not list `dialog` refuses the verb at once.
- `console` adds a small wrapper to the page's own `console.warn` and
  `console.error` on the first call. It runs in the page's own context, stays
  for the life of the document, and sees only messages after that first call.
  Uncaught errors and unhandled rejections are captured from the same point.
- `upload` takes a regular file of at most 25 MiB from the working directory,
  the dg scratch directory or the dg demos directory, never from the home
  folder itself or a working directory with a hidden folder anywhere in its
  path. It refuses hidden files and folders, a file that is a symbolic
  link, folders, and a file that changes while it is checked. The CLI stages the bytes in the local dg-daemon asset store
  before the request; the extension fetches them only for an `https:` page. The
  staged copy is deleted as soon as the extension fetches it, and also when the
  request is canceled, times out or fails.
- `tools` uses the WebMCP `document.modelContext` API, or the older
  `navigator.modelContextTesting` preview. With neither, it prints "This page
  exposes no WebMCP tools." Tool discovery and a tool call each have a timeout;
  the site's own tool code can keep running after it.
- `click` and `fill` send synthetic events. A page that checks for trusted
  input ignores them.
- A CLI newer than a running dg-daemon gets the daemon's validator error for
  `tabId` or a new verb until you restart `dg-daemon`.
- Firefox is not supported.

See [ADR 0035](adr/0035-pw-ext-real-browser.md) and
[ADR 0041](adr/0041-pw-ext-unmask.md).

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
