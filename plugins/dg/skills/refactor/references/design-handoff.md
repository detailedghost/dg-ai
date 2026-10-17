# /refactor Design & Hand-off Reference

Covers the design conversation template, hand-off mechanics, and rules. Load after the candidate gate (Step 4).

______________________________________________________________________

## §4 — Design Conversation

Invoke `/grill-me` with the chosen candidate as the topic argument:

```
/grill-me Refactor candidate: <header>. <label>. <full description>. Walk the design tree: constraints, dependencies (classify per references/deepening.md: in-process / local-substitutable / ports-and-adapters / true-external), deepened-module shape, seam placement, what tests survive, migration path.
```

During the conversation:

- Read `references/deepening.md` when classifying dependencies.
- If multiple interface designs are plausible — user is uncertain or wants to compare — read `references/interface-design.md` and run its parallel-sub-agent protocol. Otherwise stay in single-design mode.
- If a candidate names a deepened module by a concept not in `monolith.md`, flag it: `"This refactor would benefit from adding '<concept>' to monolith.md. Run /spring-break to consolidate after the work lands."`

**GATE:** Final Summary produced (purpose, deepened-module shape, dependency strategy, test plan, migration steps). User confirmed.

______________________________________________________________________

## §5 — Hand-off

Compute the slug from the header: lowercase it, replace each run of characters outside `a-z` and `0-9` with `_`, then trim leading and trailing underscores.

Write design summary to `$("$DG" stash -s refactor <slug>.md)`, then ask via `AskUserQuestion`:

| Option | Effect |
|---|---|
| **Build now via `/spec` (Recommended)** | Hand off to `/spec "<slug>"` — the refactor design seeds the planning conversation. Print: `"Refactor design at $("$DG" stash -s refactor <slug>.md). Run /spec to build the feature."` |
| **Park via `/kick`** | Hand off to `/kick <slug>` — write the spec, defer engineering. |
| **Just print the design** | Echo the summary path. No spec, no commit. User picks up later manually. |

**GATE:** Hand-off path printed; design summary file exists at `$("$DG" stash -s refactor <slug>.md)`.

______________________________________________________________________

## Rules

- **Never propose interfaces in step 3.** Candidates describe the shape of the problem, not the solution. Interface design is step 4 territory.
- **Don't fabricate candidates.** A real `[low-confidence]` is better than a polished-but-fake one.
- **Use `monolith.md` vocab for the domain, `references/language.md` vocab for the architecture.** Don't drift into "component," "service," "API," "boundary."
- **Respect ADR conflicts** if the project keeps them. Surface a contradicting candidate only when the friction is real enough to warrant revisiting; mark it `_contradicts ADR-NNNN — but worth reopening because…_`.
