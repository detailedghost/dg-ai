<!-- Engineering learnings. Max 100 lines. Prune oldest when full. -->
<!-- Format: - [YYYY-MM-DD] one learning per line, concise and actionable -->
<!-- Any agent may add entries. Prune the oldest lines when the file passes 100 lines. -->
- [2026-11-20] A module outside src/pw that imports src/pw must be listed in __tests__/pw/lazy-graph.spec.ts; keep such imports to the light pw/core/states leaf.
- [2026-11-20] A skill that tells users to run a new `dg-skills <cmd>` must name `<cmd>` in its doctor line, or doctor-coverage.spec fails.
- [2026-11-20] `dg-skills update` must run the new release's code through the bin-dir launcher, not an in-process import, or it runs the old release's code.
- [2026-11-20] sources.json holds git and command records: readSources gives git records only; readSourceRecords gives all; marks go through updateMarks.
- [2026-11-20] The job setup wizard specs use setupRig in __tests__/commands/job-setup-kit.ts: a fake daemon for the job routes and a fake client for the credential route.
