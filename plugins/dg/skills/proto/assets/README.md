# Prototype templates

Copyable templates for the local `/dg:proto` mode. Run
`~/.dg/bin/dg-skills prototype components` to print the installed directory that holds this file,
then copy the template that fits instead of writing one from scratch.

| File | Framework | Use |
|---|---|---|
| `PrototypeSwitcher.tsx` | React, Next, Vite | Switcher bar for any React prototype |
| `PrototypeSwitcher.astro` | Astro | Switcher bar for an Astro prototype |
| `prototype-decision-bar.html` | Plain HTML | Decision-only bar for a self-contained page |
| `prototype-endpoint.ts` | Node, Vite, Bun, Express | Endpoint for `POST /prototype-confirm` |
| `prototype-endpoint.next.ts` | Next App Router | Copy to `app/prototype-confirm/route.ts` |
| `prototype-endpoint.astro.ts` | Astro | Copy to `src/pages/api/prototype-confirm.ts` |
| `webmcp-tools.json` | Any | Read-only WebMCP tool definitions the served page registers |
| `dg-icons.js` | Plain JS | Icon set shared with `/dg:verify`. `prototype serve` inlines it, so `window.dgIcons` exists in a served page |

The page served by `dg-skills prototype serve` or `prototype ui` injects its own decision client
and endpoint (`window.prototypeDecide`, `window.prototypePlanDecision`, `POST /prototype-decision`).
It handles both UI-variant selection and plan-walkthrough decisions. The endpoint templates are for
a switcher mounted inside an app dev server.

The endpoint templates run `dg-skills prototype path <name>` to find the sentinel. They use
`$DG_SKILLS_BIN` when set, else the binary installed under `$HOME/.dg/bin`. Export
`PROTOTYPE_LIGHT=1` in the dev server's environment for a `--light` prototype.

The endpoint templates accept only a same-origin JSON `POST` from `localhost`, `127.0.0.1`, or
`[::1]`, and only a `name` that matches `[a-z0-9][a-z0-9_-]*`. Any other request gets a 4xx reply
and writes nothing.

## Switcher props

`PrototypeSwitcher.tsx` and `PrototypeSwitcher.astro` accept the same props.

| Prop | Type | Required | Description |
|---|---|---|---|
| `variants` | `string[]` | yes | All variant keys, such as `['A','B','C']` |
| `current` | `string` | yes | The active variant key |
| `prototypeName` | `string` | yes | Slug shown in the bar (`slug · KEY`) |
| `labels` | `object` | no | Key to label string, dimmed in the bar and the notes panel |
| `basePath` | `string` | no | Prefix for the confirm URL. Defaults to `""` |
| `port` | `number` | no | Dev server port override. React only |
| `rejectReasons` | `string[]` | no | Reject popup chips. Has a built-in default |

## Decision bar (no framework)

`prototype-decision-bar.html` carries theme, width, note, Approve, and Reject only, with no arrows or label.
Pair it with your own switcher UI and call `window.prototypeDecisionBar.setVariant(key)` from its
change handler so Approve records what is on screen. Skip the call for a single-variant prototype,
and the default `"A"` is used. Approve also fires a one-shot confetti burst, skipped under
`prefers-reduced-motion: reduce`.

## Behavior

**Navigation.** The arrow buttons and the `Left` and `Right` keys cycle variants, except while an
input, textarea, or `[contenteditable]` has focus. A change writes `?variant=<key>` with
`replaceState` and fires `popstate`, so host pages re-render without a full navigation.

**Light and dark.** The toggle writes `?mode=light|dark` to the URL and toggles a `dark` class on
`<html>`. Light is the default. The bars and toasts theme themselves from `--pd-*` (decision bar) and
`--ps-*` (switchers) custom properties keyed on `html.dark`. Style your variants against `html.dark` so one toggle themes both.

**Decision buttons**

All three bars (both switchers and the decision bar) use one icon toolbar: theme, width, the variant arrows where the bar has them, note, Approve, and Reject. Every icon has a `title` and an `aria-label`.

- **Note** toggles a note row above the icons, with the reject reason chips in the switchers. A yellow dot shows when it has text. The note rides along with the next decision.
- **Approve** POSTs `{ name, variant, variants, notes, action: "confirm" }`. It turns yellow when the note has text. It closes the tab only when the note is empty, after a confetti burst. A noted approval shows "Building the next round from &lt;key&gt;…" with a rotating border and keeps the tab open until the reload token changes.
- **Reject** needs a note. With no note it opens the note row and shows the toast "Add a note first. A rework needs direction." It POSTs `action: "reject"`, never closes the tab, and gives the bar a red, rotating border. The open tab reloads when the agent bumps the reload token.
- **Width** opens a menu: All widths, Mobile 390, Tablet 768, Desktop 1440. The choice is a CSS `max-width` on `<body>` (`html[data-proto-width]`) and is kept in `?width=`. Media queries inside the page do not react to it. Arrow keys and `Esc` work in the menu, and a click outside closes it.

**Icons.** The bars draw `window.dgIcons` from `dg-icons.js`. `prototype serve` inlines it. In your own dev server, copy `dg-icons.js` next to the page and load it with `<script src="/dg-icons.js"></script>` before the switcher. Without it, the bars show text glyphs.

Under `prefers-reduced-motion: reduce`, the confetti and the rotating border do not run.

**Reload token (Astro).** The component polls `POST <base>/prototype-confirm` with
`{ name, action: "status" }` every 2 seconds (the endpoint answers read-only, writing nothing) and
reloads when the returned token changes. It does nothing on a non-OK response or network error.
React, Next, and Vite prototypes skip this poll and use their dev server's hot reload instead.

**Focus.** Both switchers stop `focusin` from bubbling past their own root. A host page with its
own focus trap (a modal that steals focus back on any `focusin` outside itself) would otherwise
make the notes box unusable.

**Delivery.** `navigator.sendBeacon` first, so the click's user activation stays live for
`window.close()`. A `fetch` fallback runs when the beacon is refused.

`dg-skills prototype wait` reports the action (`confirm` or `reject`) and the notes text.
