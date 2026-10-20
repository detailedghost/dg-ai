# Doc section — free-form explainer payload

For rendering a prose document (explanation, memo, breakdown) with formulas,
code, tables, and callouts — instead of a plan/spec/review board. Any skill can
hand viz a `doc` payload; the board renders the blocks top to bottom.

Set `payload.doc` to an array of blocks. The section fires whenever `doc` is a
non-empty array, and coexists with any other board sections. A doc-only payload
still needs the usual `slug` (and `title` for the page header).

```jsonc
{
  "slug": "my-explainer",
  "title": "Why the Q4 numbers didn't match",
  "date": "2026-07-08",
  "static": true,
  "doc": [ /* blocks, in render order */ ]
}
```

Set **`"static": true`** on read-only explainer/diagnosis boards to disable the
live-refresh poller. Normal boards poll `/api/status` every 2.5s and swap
`#viz-main` (or full-reload) when the payload/tracks change on disk — useful for
live-updating plan/review boards, but for a one-shot doc it just causes the page
to appear to reload whenever anything re-touches `payload.json`. `static` skips
the poller entirely. Omit it (default `false`) for any board driven live via
`"$DG" viz track/respond/merge`.

## Block types

Every block has a `type`. Prose fields (`text`, `body`) accept **Markdown**
(bold, lists, links, inline `code`); raw HTML in the source is escaped, not
rendered.

- **`heading`** — `text`, plus optional `eyebrow` (uppercase kicker) and
  `level` (2 or 3). A section heading.
- **`prose`** — `text`. A Markdown paragraph block, held to a ~65ch measure.
- **`callout`** — `text`, plus optional `variant` (`info`, `warning`, `note`,
  `tip`) and `title`. A left-bordered highlight box.
- **`formula`** — optional `label`, `numerator` + `denominator` (rendered as a
  stacked fraction), `expression`, `result`, `note`. A display formula.
- **`code`** — `code`, plus optional `lang`, `title`, `caption`. A
  syntax-highlighted block (Shiki).
- **`table`** — `columns` (string array), `rows` (array of cell arrays), plus
  optional `caption`. Ledger-style; each cell is a string or `{value, tone}`.
- **`compare`** — `items`, each `{title, body, tone?}`. Side-by-side cards,
  two-up on desktop.

`tone` (table cells and compare items) is one of `good`, `bad`, `warn`,
`muted`, `accent` — semantic color, independent of the board accent.

## Example blocks

```jsonc
{ "type": "heading", "eyebrow": "The cause", "text": "Why it drifts" }
{ "type": "prose", "text": "NAV is measured **per deal**, not per family." }
{ "type": "formula", "label": "Correct percentage",
  "numerator": "this fund's NAV",
  "denominator": "total NAV of all funds" }
{ "type": "code", "lang": "sql", "title": "The filter that drops NAV",
  "code": "INNER JOIN monitoring_exp_specdeals",
  "caption": "unmatched funds contribute zero NAV" }
{ "type": "table", "columns": ["Fund", "Difference"],
  "rows": [["Nova PE III", { "value": "-$728.37", "tone": "bad" }]] }
{ "type": "compare", "items": [
  { "title": "Spreadsheet", "tone": "good", "body": "One pool." },
  { "title": "System", "tone": "bad", "body": "Deal-scoped NAV." } ] }
```
