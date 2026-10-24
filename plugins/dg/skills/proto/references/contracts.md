# Prototype contracts

Author JSON with these exact structural shapes. The CommonPackage and CLI
perform authoritative validation.

## StyleGuide

`proto --ext scrape` returns the stable path to this browser-authored value:

```jsonc
{
  "meta": {
    "url": "https://app.example.test/account",
    "scrapedAt": 1721234567890,
    "sameOrigin": true,
    "colorScheme": "light"
  },
  "tokens": {
    "customProps": { "--brand": "#1457ff" },
    "colors": ["rgb(20, 87, 255)"],
    "fontStack": "Inter, sans-serif",
    "typeScale": ["14px", "16px", "24px"],
    "spacing": ["4px", "8px", "16px"],
    "radii": ["4px", "8px"],
    "shadows": ["0 1px 2px rgb(0 0 0 / 0.1)"]
  },
  "components": {
    "button": { "background-color": "rgb(20, 87, 255)" },
    "input": { "border-radius": "4px" },
    "link": { "color": "rgb(20, 87, 255)" },
    "select": { "border-radius": "4px" },
    "textarea": { "border-radius": "4px" }
  },
  "controls": [
    { "tag": "input", "type": "radio", "classes": "form-check-input", "wrapperClasses": "form-check" },
    { "tag": "select", "classes": "form-select" },
    { "tag": "button", "type": "submit", "classes": "btn btn-primary" }
  ]
}
```

Reuse these token values verbatim in variation CSS. Do not normalize colors,
invent a parallel type scale, or substitute generic spacing. `meta.colorScheme`
and `controls` are present only when the scraped page declared a theme or had
form controls to sample; `controls` lists real host classes for radios,
checkboxes, text inputs, selects, textareas, and buttons in document order —
copy a control's `classes` (and `wrapperClasses`, when present) onto the
matching element in your variation markup rather than leaving it unstyled.

## ProtoPlan

Write this agent-authored value to `/tmp/ai/proto/<slug>/plan.json`:

```jsonc
{
  "slug": "app-example-test-account-a1b2c3d4",
  "question": "Which account summary should we implement?",
  "mountSelector": "#account-summary",
  "mode": "replace",
  "variations": [
    {
      "key": "task-first",
      "label": "Task first",
      "html": "<section class=\"summary\">...</section>",
      "css": ".summary { color: rgb(20, 87, 255); padding: 16px; }"
    }
  ]
}
```

`mountSelector` is optional. Include it only when a stable CSS selector is
known. If the intended region is described without one, or the selector is
unavailable or unstable, omit the field; the in-browser region picker will ask
the user to choose the mount area.

`mode: "replace"` hides only the selected mount and restores it when the
prototype closes. Use `mode: "takeover"` only for an explicitly requested
full-page comparison; it temporarily replaces the page body and restores every
original body node when the prototype closes.

Use 3 variations by default and cap the comparison at 5. Keys and slug are
file-safe identifiers. Keep aggregate HTML+CSS below the CLI render limit and
trim variations if the compressed URL marker exceeds its 32K transport ceiling.

Use layout, information hierarchy, and primary affordance as the variation
axes. Structurally different options might prioritize a task, a status summary,
or a guided next action; color-only alternatives do not qualify.

## Verdict

The browser authors one of these values; never write it manually:

```jsonc
{
  "slug": "app-example-test-account-a1b2c3d4",
  "action": "approve",
  "selectedKey": "task-first",
  "ts": 1721234568000
}
```

```jsonc
{
  "slug": "app-example-test-account-a1b2c3d4",
  "action": "reject",
  "selectedKey": "task-first",
  "feedback": "Keep this hierarchy but make the primary action clearer.",
  "ts": 1721234568001
}
```

```jsonc
{
  "slug": "app-example-test-account-a1b2c3d4",
  "action": "approve",
  "selectedKey": "task-first",
  "notes": "Organize the buttons.",
  "ts": 1721234568002
}
```

```jsonc
{
  "slug": "app-example-test-account-a1b2c3d4",
  "action": "tweak",
  "selectedKey": "task-first",
  "notes": "Round the corners.",
  "ts": 1721234568003
}
```

Approve triggers durable export. `notes` is optional on approve and non-empty
when present: without it the chain ends, with it the selected variation becomes
the base of the next round. Tweak requires non-empty `notes` and edits the
selected variation in place without exporting. Reject requires non-empty
feedback and starts the same-slug generation/approval/plant loop again.

## lineage.md rounds

Each exported round adds a block to `lineage.md`, next to `NOTES.md` under the
same `.agents/prototype/<slug>/` answer directory. One `## round-N` heading per
block, no wrapping section — this is the same file and format the local mode
writes (see [local-ui.md](local-ui.md) §5.5):

```text
## round-2
- base: round-1 C
- variants: A B C
- picked: B
- note: tighten the spacing
- tweaks:
  - round the corners
- status: open
```

A round with a note stays `open` until the next round starts. The round that ends
the chain is `done`. `NOTES.md` keeps the question, the latest `Verdict` JSON,
and the editing note; it no longer carries round history. A `NOTES.md` written
before `lineage.md` existed, with the round history nested under its own legacy
`## Rounds` heading, is read once on the next approve and folded into
`lineage.md`; `NOTES.md` drops the legacy section on that same write.
