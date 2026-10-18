# /refactor Discovery Reference

Covers domain context, Explore briefing, and candidate format. Load at Step 1.

______________________________________________________________________

## §1 — Domain Context Read Order

Read in this order, skipping any that don't exist:

1. `AGENTS.md` (or `CLAUDE.md` fallback) at the repo root.
1. `.agents/paths.md` — repo-specific paths.
1. `.agents/monolith.md` — canonical domain vocabulary. Use these terms in candidate descriptions; don't invent new ones when an established term fits.
1. `.agents/school/*.md` — relevant topic clusters for the scoped path.

**Domain language:** This skill is informed by the project's domain model. Use `.agents/monolith.md` terms exactly when naming a deepened module. If the deepened module needs a concept not in `monolith.md`, flag it during the design conversation: `"This refactor would introduce '<concept>' as a first-class term — propose adding it to monolith.md."`

If `.agents/monolith.md` is missing, note: `"No monolith.md found — candidate names will use file/module paths instead of domain concepts. Run /agent-seed if .agents/ itself is missing."`

______________________________________________________________________

## §2 — Explore Agent Brief

Launch the **Explore** agent on the scope path. Brief it verbatim:

> Walk `<path>` looking for **architectural friction**. Don't follow rigid heuristics — note where understanding requires bouncing between modules. For each suspicious area, note:
>
> - Files involved (paths + line ranges if useful).
> - Why the current shape causes friction (callers? tests? change locality?).
> - Apply the **deletion test**: would deleting concentrate complexity (it earns its keep) or just move it (it's a pass-through)?
>
> Heuristics — non-exhaustive:
>
> - **Shallow modules** — interface nearly as complex as the implementation.
> - **Pass-throughs** — file just forwards calls; deletion test would say "pass-through."
> - **Pure-for-testability extraction** — pure helper exists for tests, but real bugs hide in the wrapper that calls it (no locality).
> - **Tightly-coupled modules** — repeated import chains; one change forces N edits.
> - **Hard-to-test interfaces** — code only testable via heavy mocks, integration tests, or by reaching past the seam.
> - **Concept fragmentation** — one domain concept (per `.agents/monolith.md`) split across many modules.
>
> Return a list of 5–10 friction areas, ranked by impact. Use file paths + monolith.md vocabulary. Don't propose fixes yet — just surface friction.

______________________________________________________________________

## §3 — Candidate Format Spec

Synthesize Explore findings into **exactly 5 candidates** for `AskUserQuestion` (single-select). Each candidate:

- **header** — short concept name (≤12 chars), drawn from `monolith.md` if possible.
- **label** — concept-level action ("merge X into Y intake module").
- **description** — `Files: ... | Problem: ... | Solution: ... | Benefits: ...` packed into ~300 chars. Use **locality** and **leverage** when describing benefits.

If fewer than 5 high-confidence candidates surfaced, fill remaining slots with `[low-confidence]`-tagged ones rather than fabricate. Note this honestly.

The user's "Other" option (always available in `AskUserQuestion`) lets them type their own refactor target. Treat it as the chosen candidate and skip to step 4.

**GATE:** User picked one candidate (or supplied their own). If they decline all five with no "Other" input, exit gracefully: `"No candidate chosen. Run /refactor again or pick a different scope."`
