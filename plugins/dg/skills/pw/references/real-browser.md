# Real browser with `--ext`

`dg-skills pw --ext <verb>` acts on the active tab of the human's real Chromium
browser through the paired dg-ai-extension. Run one verb per Bash call.

## Save tokens

1. Run `pw --ext tools` first. If the page has a WebMCP tool that fits the task,
   use `pw --ext call <tool> <json-args>`. One tool call replaces many clicks and
   snapshots.
2. Otherwise take one `pw --ext snapshot` and act on its refs (`e4`) or on a
   narrow CSS selector. Do not take a new full snapshot or a screenshot after
   every step.
3. Use `pw --ext current` and `pw --ext selection` for small reads.
4. Take a screenshot only for a visual check. Images cost far more than text.

## Verbs

| Verb | Kind | Effect |
|---|---|---|
| `current` | read | Active tab URL and title, plus the open tabs |
| `snapshot` | read | Accessibility tree with refs, and visible text, on stdout |
| `screenshot` | read | Visible part of the tab, saved to `dg-skills stash pw` |
| `selection` | read | Selected text |
| `console` | read | Errors and console warnings since the first `console` call |
| `tools` | read | WebMCP tools of the page: name, description, input schema |
| `open <url>` | write | Opens an http or https URL in a new tab |
| `click <ref or selector>` | write | Clicks one element |
| `fill <ref or selector> <text>` | write | Sets the value of one text field |
| `upload <ref or selector> <file>` | write | Sets one file on a file input of an https page |
| `call <tool> <json-args>` | write | Runs one WebMCP tool; `json-args` is a JSON object |

## Rules

- `--ext` is the grant. The browser asks for no approval per call, so act only
  on what the human asked for.
- Refs such as `e4` come from the last `--ext snapshot` on that tab. A CSS
  selector must match exactly one element.
- The first `console` call on a tab starts capture. Call it again later to see
  errors and warnings.
- `upload` takes a regular file of at most 25 MiB from the working directory,
  the dg scratch directory or the dg demos directory. No hidden files, no
  symbolic link as the file, and not from the home folder itself.
- `call` runs the site's own code. Treat it like a click.
- Browser settings pages, extension pages, private windows and the signed-in
  Proton Mail tab are refused. Ask the human to switch to a web page tab.
  `current` and `open` still work there: `current` hides those tabs, and `open`
  opens a new tab.
- `fill` never takes passwords or secrets. Ask the human to type them.
- Output is redacted and capped. Screenshots are not redacted.
- Ctrl-C on the CLI cancels the request.
- `--ext` takes no other flags and runs no agent code. On a failure, run
  `dg-skills doctor pw`.
