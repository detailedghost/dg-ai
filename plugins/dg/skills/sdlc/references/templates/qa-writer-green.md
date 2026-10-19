# qa-writer GREEN Template (Green stage)

> [Common directives.] Read **Testing Criteria for [Slice]**. \[IF slice > 1: read `## Slice Summaries` and `## Agent Notes` (if present).\] Read implementation files below. Write additional tests for coverage gaps (edge cases, integration, error handling). **Add them to the SAME committed test file the RED stage created** (named after the code under test) — never a `green_`/`green.` file or marker (per `/standard-test` rules 7-8: red/green/plan markers must never reach a commit). Update remaining unchecked Testing Criteria.
> Report cross-slice findings via `[NOTE-DURABLE] <text>` (lands in spec) or `[NOTE-SCRATCH] <text>` (lands in scratchpad). See `agents.md` "Agent Notes Protocol".
> Implementation files: [list]
