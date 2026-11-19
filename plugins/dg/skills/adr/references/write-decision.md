# Write the Decision File

`dg-skills adr new` creates `.agents/decisions/NNNN-slug.md` beside the ADR. Agents read this file, not the ADR. Keep it terse.

## Shape

```markdown
---
covers: ["pkg/api/**", "docs/api.md"]
---

[ADR 0007](../../docs/adr/0007-slug.md)

- Rule an agent must follow, in one line.
- Another rule.
```

## Rules

- `covers:` lists path globs. An agent reads this decision when it touches a matching file. List every area the decision governs. Pass the same globs to `--covers`.
- The link line points to the paired ADR. `adr new` writes it.
- Write imperative rules. One line each. No history, no reasons, no options. The ADR holds those.
- A decision with no agent rules keeps the one line `No agent rules.` and nothing else.
- Never edit the generated tables in `.agents/decisions/README.md` or `docs/adr/toc.md`. Run `dg-skills adr index`.

Next: run `dg-skills adr lint --changed`.
