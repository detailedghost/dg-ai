---
name: refactor
description: Find architectural deepening opportunities in the current codebase. Walks the code, surfaces 5 high-leverage refactor candidates (or accepts your own), then drops into a /grill-me design conversation on the chosen one. Hands off to /kick when the design converges. Use when the user wants to improve architecture, find refactoring opportunities, consolidate tightly-coupled modules, or make a codebase more testable.
---

Resolve the CLI before using the commands below:

```bash
DG="${DG_HOME:-$HOME/.dg}/bin/dg-skills"
if [ ! -x "$DG" ]; then
  LOCAL_BOOTSTRAP="${CLAUDE_PLUGIN_ROOT:-}/pkg/skills-cli/bootstrap.sh"
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "$LOCAL_BOOTSTRAP" ]; then
    sh "$LOCAL_BOOTSTRAP"
  else
    curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/master/pkg/skills-cli/bootstrap.sh | sh
  fi
fi
```

# /refactor — Codebase Architecture Improvement

Surface architectural friction and propose **deepening opportunities** — refactors that turn shallow modules into deep ones. Goal: testability, locality, AI-navigability.

## Arguments

| Form | Effect |
|---|---|
| `/refactor` | Walk the current working directory. |
| `/refactor <path>` | Scope the walk to `<path>` (relative to cwd or absolute). |

## References (lazy-load)

| File | When to read |
|---|---|
| [references/language.md](references/language.md) | Step 1 — always. Architecture vocabulary and key principles. |
| [references/discovery.md](references/discovery.md) | Step 1 — always. Domain context read order, Explore brief, candidate format. |
| [references/deepening.md](references/deepening.md) | Step 4 — classify dependencies for the chosen candidate. |
| [references/design-handoff.md](references/design-handoff.md) | Step 4 — after candidate selected. Design conversation template, hand-off mechanics, rules. |
| [references/interface-design.md](references/interface-design.md) | Step 4 — only when multiple interfaces are plausible; parallel sub-agent protocol. |

## Phase Sequence

1. **Domain context** — read project context files and architecture vocabulary.
2. **Explore** — launch Explore agent on scope path. Returns 5–10 friction areas ranked by impact.
3. **Present candidates** — synthesize into exactly 5; present via `AskUserQuestion` (single-select). **GATE:** user picks one or supplies their own via "Other."
4. **Design conversation** — invoke `/grill-me` with chosen candidate. **GATE:** Final Summary confirmed.
5. **Hand-off** — write design summary; ask: park the build (`/kick`) or print only. **GATE:** summary file written.
