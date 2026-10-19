# ADRs — Three-Gate Test + Template

At convergence, walk every `[DECIDED]` item in the decision log. Write an ADR only when ALL three gates pass:

1. **Reversal cost** — meaningful effort, data migration, or breakage to undo the decision later
1. **Reader confusion** — a future engineer reading the code alone will not understand *why* it has this shape
1. **Real trade-off** — genuine alternatives existed and were weighed; not an obvious default

If any gate fails: skip. The Final Summary already captures it; an ADR for an obvious call is noise.

## Location and Numbering

ADRs live in `<adr-root>/NNNN-slug.md`. `<adr-root>` is `docs/adr` when that directory exists, and `.agents/decisions` otherwise, because agent-seed ignores `.agents/`. Create the directory if missing. When the root has an index (such as `toc.md`), add a line for the new record.

To pick the next number:

```sh
ls <adr-root>/ 2>/dev/null | grep -E '^[0-9]{4}-' | sort | tail -1
```

Increment the leading number, zero-padded to 4 digits. The first ADR is `0001-...`.

`slug` is short kebab-case — a couple of words, enough to identify the decision at a glance.

## Template

```markdown
# NNNN — <short decision title>

- **Status:** accepted
- **Date:** YYYY-MM-DD
- **Branch:** <design-tree branch this came from>

## Context

What was the situation? What constraints were in play? Reference specific files
or behaviors from the codebase.

## Options Considered

- **Option A** — short description. Pros: ... Cons: ...
- **Option B** — short description. Pros: ... Cons: ...
- **Option C** — (if applicable)

## Decision

We chose <Option X> because ...

## Consequences

- What becomes easier
- What becomes harder
- Anything to revisit later
```
