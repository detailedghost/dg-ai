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
3. Use `pw --ext current` and `pw --ext selection` for small reads. Use
   `pw --ext tabs` to list your tabs.
4. Take a screenshot only for a visual check. Images cost far more than text.

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
| `open <url>` | write | Opens an http or https URL in the selected tab, or in a new tab when the agent has none |
| `new [url]` | write | Opens a new tab in the agent's group and selects it; with no URL it opens a blank tab |
| `select <tabId>` | write | Makes a tab of the group the selected tab |
| `close [tabId]` | write | Closes a tab of the group; the selected tab by default |
| `click <ref or selector>` | write | Clicks one element |
| `fill <ref or selector> <text>` | write | Sets the value of one text field |
| `upload <ref or selector> <file>` | write | Sets one file on a file input of an https page |
| `call <tool> <json-args>` | write | Runs one WebMCP tool; `json-args` is a JSON object |

## Rules

- `--ext` is the grant. The browser asks for no approval per call, so act only
  on what the human asked for.
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
- Browser settings pages, extension pages, private windows and the signed-in
  Proton Mail tab are refused. Ask the human to hand you a web page tab.
  `tabs`, `new` and `close` still work when the selected tab is a settings page,
  and `open` navigates it to a web page. `tabs` hides the URL and title of those
  tabs. The Proton Mail tab is never read, closed or navigated.
- `fill` never takes passwords or secrets. Ask the human to type them.
- Output is redacted and capped. Screenshots are not redacted.
- Ctrl-C on the CLI cancels the request.
- `--ext` runs no agent code. On a failure, run `dg-skills doctor pw`.
- An extension older than the one that ships tab groups is refused with the
  update text. Update the extension, reload it, and reconnect the session. A
  running `dg-daemon` older than the CLI answers a `--tab` or a new verb with its
  own validator error until you restart it.
