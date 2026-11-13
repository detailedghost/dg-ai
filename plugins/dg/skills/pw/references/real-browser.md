# Real browser with `--ext`

`dg-skills pw --ext <verb>` acts on the agent's selected tab in the human's real
Chromium browser through the paired dg-ai-extension. Run one verb per Bash call.
Your tabs sit in one tab group of their own. You see and act only on tabs in that
group, until the human hands you a tab from the extension popup.

## Save tokens

1. Run `pw --ext tools` first. If the page has a WebMCP tool that fits the task,
   use `pw --ext call <tool> <json-args>`. One tool call replaces many clicks and
   snapshots.
2. Otherwise take one `pw --ext snapshot` and act on its refs (`e4`) or on a
   narrow CSS selector. Do not take a new full snapshot or a screenshot after
   every step.
3. To test a selector, run `pw --ext count <selector>`. It changes nothing.
   Never test a selector with `click`, `fill` or `upload`: one match acts at once.
4. Use `pw --ext current` and `pw --ext selection` for small reads. Use
   `pw --ext tabs` to list your tabs.
5. Take a screenshot only for a visual check. Images cost far more than text.

## Verbs

| Verb | Kind | Effect |
|---|---|---|
| `current` | read | URL and title of the agent's selected tab |
| `tabs` | read | The tabs in the agent's group, the selected one marked |
| `snapshot` | read | Accessibility tree with refs, and visible text, on stdout |
| `screenshot` | read | Visible part of the tab, saved to `dg-skills stash pw`; brings the tab to the front first |
| `selection` | read | Selected text |
| `console` | read | Errors and console warnings since the first `console` call |
| `tools` | read | WebMCP tools of the page: name, description, input schema |
| `count <ref or selector>` | read | How many elements match, with tag, type, id and name for each. Test a selector with it before `click`, `fill` or `upload` |
| `open <url>` | write | Opens an http or https URL in the selected tab, or in a new tab when the agent has none |
| `new [url]` | write | Opens a new tab in the agent's group and selects it; with no URL it opens a blank tab |
| `select <tabId>` | write | Makes a tab of the group the selected tab |
| `close [tabId]` | write | Closes a tab of the group; the selected tab by default |
| `click <ref or selector>` | write | Clicks one element |
| `fill <ref or selector> <text>` | write | Sets one text field, or a date or time field (`date` as `YYYY-MM-DD`, `time` as `HH:MM`, plus `datetime-local`, `month` and `week`), or picks one `<select>` option by value, then label, then case-insensitive label. A multi-select is refused |
| `fill <ref or selector> --value-env NAME` | write | Sets a password or secret field from your environment variable `NAME`. Needs an `unmask` grant |
| `fill <ref or selector> --value-stdin` | write | Same, but reads the value from stdin. Needs an `unmask` grant |
| `unmask [--minutes N]` | write | Asks the human, in a browser popup, to unmask the selected tab's origin for `N` minutes (1 to 60, default 15). `unmask --off` ends it |
| `upload <ref or selector> <file>` | write | Sets one file on a file input of an https page |
| `call <tool> <json-args>` | write | Runs one WebMCP tool; `json-args` is a JSON object |
| `dialog` | write | Shows the page's last `alert`, `confirm` or `prompt`, how it was answered, and the answer set for the next one |
| `dialog accept [--text <answer>]` | write | Accepts the next dialog on the page; `--text` answers a `prompt` |
| `dialog dismiss` | write | Dismisses the next dialog on the page |

## Rules

- `--ext` gives you the agent's tab group. The first verb on a new site in a
  session, `open` and `new` too, asks the human in a popup to allow that site
  for the session. Ask for sites only as the task needs them; a denied site
  touches no page. Act only on what the human asked for.
- Each agent tab shows an "Agent is driving this tab" banner with a Stop button.
  If the human clicks Stop, every verb fails with an error that names Stop.
  Stop then: do not retry, and tell the human the session lost control.
- Each dg session has its own tab group. The CLI picks the session from
  `--session <id>`, then the `DG_SESSION_ID` environment variable, then the one
  session registered for the working directory. Under `--ext`, `--session` takes
  a dg session id, not a pw browser session name.
- Every verb acts on the agent's selected tab. `--tab <id>` targets one tab of
  the group once and leaves the selection alone. It cannot go with `tabs`,
  `new` or `select`, and it cannot go with a tab id on `close`.
- A tab outside the agent's group is refused, including the human's own tabs and
  the tabs of other agents. If the human closes or moves the selected tab, run
  `pw --ext tabs`, then `pw --ext select <id>`.
- A group holds at most 200 tabs. `new` and a first `open` stop at that limit.
- `screenshot` brings the tab to the front and leaves it there.
- Refs such as `e4` come from the last `--ext snapshot` on that tab. A CSS
  selector must match exactly one element.
- The first `console` call on a tab starts capture. Call it again later to see
  errors and warnings.
- `upload` takes a regular file of at most 25 MiB from the working directory,
  the dg scratch directory or the dg demos directory. No hidden files, no
  symbolic link as the file, and not from the home folder itself.
- `call` runs the site's own code. Treat it like a click.
- Page dialogs never block you. Each `alert`, `confirm` and `prompt` in your tab
  is answered at once: dismissed by default. To accept one, run
  `pw --ext dialog accept [--text <answer>]` first, then do the action again.
  The answer is used once, and a new page starts again at dismiss. `dialog`
  shows the last dialog, and `snapshot` lists new ones under `### Dialog`. If a
  verb stops with "It may show a dialog", ask the human to close it.
- Browser settings pages, extension pages, private windows and the signed-in
  Proton Mail tab are refused. Ask the human to hand you a web page tab.
  `tabs`, `new` and `close` still work when the selected tab is a settings page,
  and `open` navigates it to a web page. `tabs` hides the URL and title of those
  tabs. The Proton Mail tab is never read, closed or navigated.
- Without a grant, `fill` refuses passwords and secrets. To get real email
  addresses or a secret fill, run `pw --ext unmask [--minutes N]` and tell the
  human to click Allow in the popup. User names are not masked. Deny, no answer
  in 60 seconds, a closed window, or a window that cannot open grants nothing;
  the reply says which. You cannot grant it yourself. Ask only when the task
  needs it.
- A grant covers one origin, in your tab group only, until its time, until
  `pw --ext unmask --off`, or until the tab group changes or closes. It never
  covers a mailbox or a browser-internal page. Run `unmask --off` as soon as you
  finish. Tokens, API keys, JWTs and `password=` values stay masked.
- Each reply under a grant starts with `### Unmask` and
  `unmasked on <origin> until HH:MM (approved in the browser)`.
- Never put a secret in argv. Use `fill <target> --value-env NAME` or
  `--value-stdin`. These work only on a password or secret field, with a value
  of at least 4 characters. The result says only `filled <field>`, and later
  output of the session masks the value.
  An extension that lacks `unmask` refuses the verb at once.
- Output is redacted and capped. Screenshots are not redacted.
- Ctrl-C on the CLI cancels the request.
- `--ext` runs no agent code. On a failure, run `dg-skills doctor pw`.
- An extension older than the one that ships tab groups is refused with the
  update text. Update the extension, reload it, and reconnect the session. A
  running `dg-daemon` older than the CLI answers a `--tab` or a new verb with its
  own validator error until you restart it.
- After an extension reload, run `pw --ext new` again. The reload clears the
  agent's tab binding.
