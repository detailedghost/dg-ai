# Correction Templates

All correction agents: report cross-slice findings via `[NOTE-DURABLE] <text>` (lands in spec) or `[NOTE-SCRATCH] <text>` (lands in scratchpad). See `agents.md` "Agent Notes Protocol".

## Engineering

> [Common directives.] Read slice section. Fix issues below. No refactoring beyond fixes. Do not edit the spec or report unticked checkboxes; the orchestrator ticks them.
> Spec diff: [if applicable]
> Issues: [grouped by source + severity + rationale]

## qa-writer

> [Common directives.] Read Testing Criteria. Fix test issues below. No refactoring beyond fixes. Do not edit the spec or report unticked checkboxes; the orchestrator ticks them.
> Issues: [grouped by source + severity + rationale]

## Reviewer Re-Run

> [Common directives.] Re-read ONLY corrected files. Verify findings resolved. Report remaining + net-new issues, same format.
> Original findings: [list]
> Corrected files: [list]
