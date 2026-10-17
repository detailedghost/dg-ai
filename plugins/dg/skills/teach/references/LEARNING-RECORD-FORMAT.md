# Learning Record Format

Learning records live in `./learning-records/` and use sequential numbering: `0001-slug.md`, `0002-slug.md`, etc. Create the directory lazily — only when the first record is written.

They are the teaching equivalent of ADRs: non-obvious lessons, key insights, and stated prior knowledge that steer future sessions. Used to calculate zone of proximal development.

## Template

```md
# {Short title of what was learned or established}

{1-3 sentences: what was learned (or what prior knowledge was established), and why it matters for future sessions.}
```

That is the whole format. The value is recording _that_ this is now known and _why_ it changes what to teach next.

## Optional sections

Only add these when they genuinely help. Most records won't need them.

- **Status** frontmatter (`active | superseded by LR-NNNN`) — when an earlier understanding is replaced.
- **Evidence** — how the user demonstrated understanding (question answered, exercise completed, prior experience cited).
- **Implications** — what this unlocks or rules out. Worth recording when non-obvious.

## When to write a learning record

1. **The user demonstrated genuine understanding of something non-trivial** — not just exposure, but evidence they can use the concept.
2. **The user disclosed prior knowledge** — record depth claimed so future sessions don't re-teach it.
3. **A misconception was corrected** — high-value; predicts future stumbling blocks on related topics.
4. **The mission shifted in response to learning** — cross-link to `MISSION.md` and update it.

Coverage alone does not qualify. Wait for evidence of understanding.

## Supersession

When a later record contradicts an earlier one, mark the old record `Status: superseded by LR-NNNN` rather than deleting it. The evolution of understanding is useful signal.

## Numbering

Scan `./learning-records/` for the highest existing number and increment by one.
