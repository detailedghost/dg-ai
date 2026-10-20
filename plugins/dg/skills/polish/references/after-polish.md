# Code review

Polish is quality-only. It does NOT hunt for correctness or security bugs — that's a separate pass. After polish (or independently), run the `code-review` skill over the same diff for correctness/logic/efficiency defects, and route security concerns to the configured security agent. Treat polish (taste/hygiene) and code-review (bugs) as complementary steps, not substitutes: a clean-reading diff can still be wrong.

## Making a PR

When the polish (and any code review) pass is done and you're opening a PR, load [pr.md](pr.md) for the description conventions — it caps the body at **4 sentences of prose** plus a simple table, meaningful bullets, and/or a demo video, and pipes the body to `gh` via stdin rather than a `.md` file. For **stacked or dependent PRs** use the [chain](../../chain/SKILL.md) skill (arrow-chain `## Stack (merge order)` block + base-branch retargeting) — do not hand-roll a prose "depends on X" note.
