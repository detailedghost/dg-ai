---
name: viz
description: Render a board payload as a styled HTML page in a local Astro dev server. Ephemeral, environment-agnostic rendering client used by /review; one session-namespaced window per invoke, nothing persisted.
---

# /viz

Resolve the CLI before using the commands below:

```bash
DG="${DG_HOME:-$HOME/.dg}/bin/dg-skills"
if [ ! -x "$DG" ]; then
  LOCAL_BOOTSTRAP="${CLAUDE_PLUGIN_ROOT:-}/pkg/skills-cli/bootstrap.sh"
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "$LOCAL_BOOTSTRAP" ]; then
    sh "$LOCAL_BOOTSTRAP"
  else
    curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.16.0/pkg/skills-cli/bootstrap.sh | sh
  fi
fi
```

Render a board payload as a styled HTML page in a local Astro dev server.

**Prerequisite.** The viewer runs on Bun, which is not bundled with `dg-skills`. Install it from https://bun.sh if `"$DG" viz doctor` reports a missing Bun. The first render runs `bun install` once in this skill's `astro-viewer/` directory; the viewer location comes from the installed skill (`VIZ_SKILL_DIR` overrides it).

**Ephemeral + environment-agnostic.** All files live in the temp `VIZ_DIR` (default `$("$DG" stash -G viz)`) — no repo or git needed. Nothing persists; the board is in-flight only.

**One window per invoke.** The slug is namespaced by session id, so concurrent chats never collide. Re-rendering in the same chat reuses that window (idempotent).

## Usage

```
/viz [--no-open]
```

`--no-open` — print URL only, skip browser  
(`--keep` is deprecated and ignored — viz is always ephemeral)

## Routing

| Task | Read |
|---|---|
| Running CLI commands programmatically (render, wait, merge, annotate, list, clean, stop, review) | `references/cli.md` |
| Rendering the GitHub-PR style code-review board (`"$DG" viz review`/`wait`/`review-wait`) | `references/cli.md` |
| Full payload field reference, or the minimal payload shape + `template`/`mode` distinction | `references/payload-schema.md` |
| Rendering a free-form explainer (prose, formulas, code, tables) instead of a plan/spec/review board | `references/doc-schema.md` |
| Running the blocking decision/open-questions loop, or handling thread entries after `wait --merge`; review-submit round-trip | `references/loop-protocol.md` |

## Sections are registry-driven

All sections are defined in `astro-viewer/src/sections/registry.ts`. Each section renders when `applies(payload)` returns true — add a section by dropping a `*Section.astro` file, adding one registry entry, and one import+map entry in `BoardView.astro`.

## Foreman integration

At plan finalization: ask `Render in browser? [y/N]`. If yes, write payload and call `"$DG" viz --input`. The board is in-flight only — the persisted spec artifact is still just the spec `.md`, never the viz output.

## Known limitation

`viz stop` and `viz doctor` verify the viewer process through `/proc`, so they work on Linux and WSL only. On macOS they treat a live viewer as stale and do not signal it.
