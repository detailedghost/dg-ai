# prototype ui — self-contained UI variants, zero ceremony

`dg-skills prototype ui` wraps the self-contained UI-variants flow (`prototype serve` + `prototype selection wait`) into one command an agent can drive without hand-wiring serve+wait itself, and without hitting the cwd-pickup bug described below.

**Why this exists, not `prototype serve`/`prototype selection` directly:** a harness that resets cwd between tool calls can make the directory a bare `serve`+`wait` pair resolves diverge: the real pick lands in one directory while `wait` watches another, and the agent sees "pending" or a timeout forever, even though the user already clicked Approve/Reject. `prototype ui` pins every call it makes for one session to one fixed absolute cwd, so it doesn't matter what the caller's ambient `$PWD` is on any given tool call.

## One command

```sh
~/.dg/bin/dg-skills prototype ui <manifest-file|-> [--light] [--port=N] [--timeout=SEC]
```

Renders the manifest to a self-contained HTML file, serves it, opens it in the browser, blocks until a decision, and prints exactly one JSON line:

```json
{"status":"ok","variant":"B","notes":"ship it"}
{"status":"rejected","notes":"too busy, try flatter neutrals"}
{"status":"timeout"}
```

**Rework loop:** on reject, edit the manifest and run the exact same command again. `prototype ui` recognizes the session by the manifest's `name`, reuses the already-running server (re-renders the HTML in place and bumps the reload token) instead of starting a new one, and the open tab refreshes on its own.

Two supporting subcommands, both anchored to the session's recorded state (never ambient `$PWD`) — useful for checking in on a session from a different shell or after a compacted context:

```sh
~/.dg/bin/dg-skills prototype ui wait <name> [--timeout=SEC]   # block for a decision (consumes it)
~/.dg/bin/dg-skills prototype ui status <name>                 # non-consuming: variant | rejected | pending
```

## Manifest format

Markdown was chosen over hand-escaped JSON so HTML fragments need **zero escaping**. Under the hood, `prototype ui` parses this into the same `ProtoPlan` contract `dg-skills proto` validates for the extension flow (see [contracts.md](contracts.md)) — the markdown is authoring sugar in front of one shared plan/variation format, not a second format.

```
---
name: <required — session identifier, also the sentinel/state-file key>
title: <optional — <title>, defaults to name>
theme: <optional — light | dark | auto (default)>
data:
  <optional flat key: value map for {{key}} interpolation>
labels:
  <optional variant-key: human label map, shown in the nav>
reject_reasons:
  <optional quick-pick chips for the reject note>
---

::: KEY
<raw HTML — whatever the agent wants, unescaped>
:::

::: OTHER_KEY
<raw HTML>
:::
```

Only `name` + at least one variant is required. Everything else is optional with sensible defaults. Unknown frontmatter keys are ignored with a warning, not a failure.

**Single-variant, zero ceremony** — skip the `:::` fences entirely and the whole body becomes one implicit variant keyed `A`:

```
---
name: quick-look
---
<h1>Just render this</h1>
<p>No fences needed for one variant.</p>
```

**`{{key}}` interpolation** is a flat string replace against the `data` map — no logic, no loops, no conditionals. Type a shared value once, reference it in every variant:

```
---
name: pricing-cards
data:
  cta: Start free trial
  brand: Acme
---

::: A
<h1>{{brand}}</h1>
<button>{{cta}}</button>
:::

::: B
<h1>{{brand}} — compact</h1>
<button>{{cta}}</button>
:::
```

**Piping from stdin** — pass `-` instead of a file path so an agent can pipe HTML straight in without writing a temp file:

```sh
cat <<'EOF' | ~/.dg/bin/dg-skills prototype ui - --light
---
name: pasted-idea
---
<div style="padding:2rem">
  <h1>Whatever HTML the agent just generated</h1>
</div>
EOF
```

## Worked examples

### 1. Single variant, bare HTML

```
---
name: empty-state-v1
---
<div style="max-width:480px;margin:4rem auto;text-align:center;">
  <h2>No results yet</h2>
  <p>Try adjusting your filters.</p>
</div>
```

```sh
~/.dg/bin/dg-skills prototype ui empty-state.md --light
```

### 2. Multi-variant with labels and reject reasons

```
---
name: settings-page
title: Settings — layout options
labels:
  A: Card grid
  B: Sidebar nav
  C: Single column
reject_reasons:
  - Too busy
  - Wrong information hierarchy
  - Doesn't match existing pages
---

::: A
<div class="cards">... card grid markup ...</div>
:::

::: B
<div class="sidebar-layout">... sidebar markup ...</div>
:::

::: C
<div class="single-column">... stacked markup ...</div>
:::
```

```sh
result=$(~/.dg/bin/dg-skills prototype ui settings-page.md --light --timeout=600)
```

### 3. Shared data across variants

```
---
name: cta-copy-test
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

## In the served page

- **Approve ✓ (keep + tweak)** — records the currently-viewed variant as the pick; any notes ride along.
- **Reject ⟲ (start over — all)** — requires a non-empty note (what should change) before it can be sent; quick-pick reason chips prefill the note.
- `←`/`→` cycle variants (suppressed while a text field is focused); the URL stays reload-stable via `?variant=`.
- The bar calls the injected `window.prototypeDecide(action, variant, notes)` global — the same transport `prototype serve` already wires up. Nothing in the manifest or the rendered page reimplements POST/beacon delivery.

## Gotcha: raw HTML fragments

Variant bodies are inserted verbatim inside `<section data-variant="KEY">`. Don't include a stray `</section>` or `</body>` in a fragment — it will prematurely close the wrapper. Everything else (styles, scripts, nested tags) is fine as-is.
