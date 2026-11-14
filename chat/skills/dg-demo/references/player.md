# Player data

The player reads one JSON object from `<script type="application/json" id="dg-tour">`.

```json
{
  "title": "Saved filters",
  "stage": "mock",
  "intro": { "eyebrow": "Demo", "title": "Saved filters", "detail": "Keep your views" },
  "outro": { "eyebrow": "Done", "title": "That is it", "detail": "Thanks for watching" },
  "steps": [
    {
      "title": "Save a filter",
      "body": "Keep the current filters.",
      "selector": "#save-filter-btn",
      "action": { "type": "click" },
      "timing": 3000
    },
    {
      "title": "Name it",
      "body": "Type a name.",
      "selector": "input[name=\"filter-name\"]",
      "action": { "type": "type", "text": "Open bugs" },
      "timing": 4000
    },
    {
      "title": "Filters page",
      "body": "It shows up here.",
      "navigate": "http://localhost:4200/filters",
      "timing": 4000
    }
  ]
}
```

## Fields

| Field | Type | From the plan |
| --- | --- | --- |
| `title` | string | frontmatter `title` |
| `stage` | `"mock"` or `"screenshots"` | frontmatter `stage` |
| `intro`, `outro` | `{ eyebrow, title, detail }` or `null` | `"Eyebrow \| Title \| Detail"` split on `\|` |
| `steps[].title` | string | `**title**` |
| `steps[].body` | string | the text after the em dash |
| `steps[].selector` | string | `` `selector` `` (mock stage) |
| `steps[].navigate` | string | `→ url`, matched against `data-dg-url` (mock stage) |
| `steps[].screen` | string | none; the `data-dg-screen` id (screenshot stage) |
| `steps[].box` | `{ x, y, w, h }` in percent | none; the target's box on the screenshot |
| `steps[].action` | `{ "type": "click" }` or `{ "type": "type", "text": "…" }` | `@click`, `@type="…"` |
| `steps[].timing` | milliseconds, `"next"` or `"click"` | `` `4s` `` → `4000`, `` `500ms` `` → `500` |

Leave out a field the step doesn't use. With no `timing`, a step holds about
3.5 seconds.

## Controls

- ▶ plays the intro card and then each step in turn, running its action. ❚❚ pauses.
  At the end, ↻ replays.
- « ‹ › » jump to the first step, back one, forward one, and to the last step. › also
  runs the step's action, or the click a `click`-timed step is waiting for.
- The arrow keys step and the space bar plays or pauses, except while an input has focus.
- **Plan** shows the Markdown plan under the player.
