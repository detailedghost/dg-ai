# Plan view

The terminal view of `plan.md` for the plan approval gate. Print it as plain markdown. `plan.md` stays the full durable spec; this view is a short, readable summary of it.

Rules:

- Short sections, clean bullets, plain words, short lines. No dense paragraphs. No long tables.
- Start a line with 👀 when the user should double-check it: assumptions, `[ASSUMED]` contracts, risky or one-way decisions, open questions, external or security impact, behavior changes.
- The `👀 Check these` list goes first, right after the title. One line per item. Write `👀 Nothing to double-check` when the list is empty.

Layout:

```markdown
# <Plan title>
Bundle: <bundle path> · Status: <status> · Slices: <count>

## 👀 Check these
- 👀 <one-line item>

## Purpose
- <what and why, one or two bullets>

## Scope
- In: <bullet per item>
- Out: <bullet per item>

## Slices
### <id> <name> (after: <depends_on>)
- Builds: <what it builds>
- Tested by: <how it is tested>
- 👀 <risk or open point, only when there is one>

## Risks
- 👀 <risk>

## Open questions
- 👀 <question>

## Cost
- <token-cost warning from step 7, one line>
```

After the view, ask with `AskUserQuestion`:

- Approve: continue to the next step.
- Rework: the user says what to change. Revise `plan.md`, print the view again, and ask again. Loop until Approve.
