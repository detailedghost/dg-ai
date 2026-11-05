# Real browser with `--ext`

`dg-skills pw --ext <verb>` acts on the active tab of the human's real Chromium
browser through the paired dg-ai-extension. Run one verb per Bash call.

## Verbs

| Verb | Kind | Effect |
|---|---|---|
| `current` | read | Active tab URL and title, plus the open tabs |
| `snapshot` | read | Accessibility tree with refs, and visible text, on stdout |
| `screenshot` | read | Visible part of the tab, saved to `dg-skills stash pw` |
| `selection` | read | Selected text |
| `console` | read | Uncaught errors since capture started on the tab |
| `open <url>` | write | Opens an http or https URL in a new tab |
| `click <ref or selector>` | write | Clicks one element |
| `fill <ref or selector> <text>` | write | Sets the value of one text field |

## Rules

- Every call opens an approval window in the browser. Tell the human to look
  there. If they deny, stop. Do not retry the same call.
- Refs such as `e4` come from the last `--ext snapshot` on that tab. A CSS
  selector must match exactly one element.
- The first `console` call on a tab starts capture. Call it again later to see
  errors.
- Browser settings pages, extension pages, private windows and the signed-in
  Proton Mail tab are refused. Ask the human to switch to a web page tab.
  `current` and `open` still work there: `current` hides those tabs, and `open`
  opens a new tab.
- The approval window shows the full `fill` text.
- `fill` never takes passwords or secrets. Ask the human to type them.
- Output is redacted and capped. Screenshots are not redacted.
- `--ext` takes no other flags and runs no code. On a failure, run
  `dg-skills doctor pw`.
