<!-- Engineering learnings. Max 100 lines. Prune oldest when full. -->
<!-- Format: - [YYYY-MM-DD] one learning per line, concise and actionable -->
<!-- Any agent may add entries. Prune the oldest lines when the file passes 100 lines. -->
- [2026-11-20] A module outside src/pw that imports src/pw must be listed in __tests__/pw/lazy-graph.spec.ts; keep such imports to the light pw/core/states leaf.
- [2026-11-20] A skill that tells users to run a new `dg-skills <cmd>` must name `<cmd>` in its doctor line, or doctor-coverage.spec fails.
