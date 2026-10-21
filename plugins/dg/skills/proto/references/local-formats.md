# Plan and variant formats, and `prototype ui`

`~/.dg/bin/dg-skills prototype ui` renders variants into one self-contained page, serves it on
localhost, opens it in the browser, blocks until a decision, and prints exactly one JSON line:

```json
{"status":"ok","variant":"B","notes":"ship it"}
{"status":"rejected","notes":"too busy, try flatter neutrals"}
{"status":"timeout"}
```

It is the default way to show variants that have no host app. Nothing else is needed to show
prose, tables, code blocks, or compare cards: they are plain HTML inside a variant.

```sh
~/.dg/bin/dg-skills prototype ui <plan.json|manifest.md|-> [--chain=NAME] [--series] [--light] [--port=N] [--timeout=SEC] [--no-open]
```

| Option | Effect |
|---|---|
| `--chain=NAME` | Chain key. One chain is one server, one port, one tab. Defaults to the plan `slug`, else the manifest's chain value, else its `name`. |
| `--series` | Keep the server and tab after an approve with no notes, for a planned set of prototypes. |
| `--light` | Keep the sentinels in the scratch bucket for the pinned session folder. A `ui` session records its own sentinel directory either way, so claim the decision with `prototype wait <chain>` and never by path. |
| `--port=N` | First port to try. Default 4321. It moves to the next free port when taken. |
| `--timeout=SEC` | Seconds to wait for a decision, and the server's idle limit. Default 900. |
| `--no-open` | Do not open the browser. `PROTOTYPE_UI_NO_OPEN=1` does the same. |

Pass `-` to read the plan or manifest from stdin, so you can pipe HTML without a temp file.

## Plan format (shared with `--ext`)

The ProtoPlan JSON that the `--ext` mode plants in a live page also works here. Author it once and
run it in either mode. See [contracts.md](contracts.md) for the full contract. The local mode reads these fields:

```jsonc
{
  "slug": "settings-page",
  "question": "Which layout works best for settings?",
  "mode": "replace",
  "variations": [
    { "key": "cards", "label": "Card grid", "html": "<div class=\"cards\">...</div>", "css": ".cards { display: grid; }" },
    { "key": "sidebar", "label": "Sidebar nav", "html": "<div class=\"layout\">...</div>", "css": "" }
  ]
}
```

- `slug` is the chain key and the sentinel folder name. Keep it the same in every round.
- `question` becomes the page title.
- Each `label` shows in the bar. Each variation's `css` is scoped to that variation with `@scope`, so one variant's styles cannot leak into another.
- The local mode has no five-variation cap and does not scrape a style guide. `mountSelector` and `mode` are validated but unused.

## Manifest format

Markdown lets HTML fragments need no escaping. Use it for quick variants with shared data.

```
---
name: <required, the round name; also the chain key when no chain value is set>
chain: <optional, refine-chain key; reuse one server and tab across rounds>
title: <optional, the page title, defaults to name>
theme: <optional, light | dark | auto (default)>
data:
  <optional flat key: value map for {{key}} interpolation>
labels:
  <optional variant-key: human label map, shown in the bar>
reject_reasons:
  <optional quick-pick chips for the reject note>
---

::: KEY
<raw HTML, unescaped>
:::

::: OTHER_KEY
<raw HTML>
:::
```

Only `name` and one variant are required. An unknown frontmatter key warns on stderr and does not
fail. With no `:::` fences, the whole body is one variant keyed `A`. `{{key}}` is a flat string
replace against `data`: no logic, loops, or conditionals.

Variant bodies sit verbatim inside `<section data-variant="KEY">`. Do not put a stray `</section>`
or `</body>` in a fragment: it closes the wrapper early.

## Chains, rounds, and the session

- **Rework loop.** On a reject, edit the plan and run the same command again. The session is found by its chain key. It reuses the running server, re-renders in place, clears stale decisions, bumps the reload token, and the open tab refreshes. No new tab opens.
- **Rounds.** Give every round of a chain the same plan `slug`, or the same chain value in the manifest. Round N+1 re-renders into the running server.
- **Idle limit.** The server exits after `--timeout` seconds with no decision and no new round. A later round starts a fresh server and bumps the reload token, so a tab left open on that port reloads. Ask for the same `--port` when you restart a chain so the open tab can find it.
- **Claim from any directory.** The session records its own sentinel directory. `prototype wait <chain>`, `prototype status <chain>`, and `prototype stop <chain>` read that record, never the ambient working directory. A session `wait` prints one JSON line and consumes the decision. `status` does not consume anything.
- **Stop.** `~/.dg/bin/dg-skills prototype stop <chain>` stops the server and drops the session. It is safe to run twice. An approve with no notes stops the server too, unless the run used `--series`.

## In the served page

- **Approve (keep and tweak)** records the viewed variant as the pick. Notes ride along. With notes, the page shows "Building the next round" and reloads when the next round is rendered. Without notes, the tab closes.
- **Reject (start over)** needs a non-empty note before it can be sent. Quick-pick chips prefill the note.
- `Left` and `Right` arrow keys cycle variants, except while a text field has focus. `?variant=` keeps the URL reload-stable.
- The bar calls the injected `window.prototypeDecide(action, variant, notes)`. A plan walkthrough calls `window.prototypePlanDecision(decision, notes)`. Never re-implement the POST in a variant.
- The page registers two read-only WebMCP tools, `get_prototype_state` and `list_prototype_variants`, when the browser supports them.

## Worked examples

A single variant with no fences:

```
---
name: empty-state
---
<div style="max-width:480px;margin:4rem auto;text-align:center;">
  <h2>No results yet</h2>
  <p>Try adjusting your filters.</p>
</div>
```

Shared data across variants:

```
---
name: cta-copy
data:
  headline: Ship faster with less ceremony
  cta: Get started
---

::: A
<section class="hero-left"><h1>{{headline}}</h1><button>{{cta}}</button></section>
:::

::: B
<section class="hero-centered"><h1>{{headline}}</h1><button>{{cta}}</button></section>
:::
```

Piping from stdin:

```sh
cat <<'EOF' | ~/.dg/bin/dg-skills prototype ui - --light
---
name: pasted-idea
---
<div style="padding:2rem"><h1>Whatever HTML the agent just generated</h1></div>
EOF
```
