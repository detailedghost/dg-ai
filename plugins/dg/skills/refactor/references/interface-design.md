# Interface Design

When the user wants to explore alternative interfaces for a chosen deepening candidate, use this parallel sub-agent pattern. Based on "Design It Twice" (Ousterhout) — your first idea is unlikely to be the best.

Adapted from [mattpocock/skills/improve-codebase-architecture/INTERFACE-DESIGN.md](https://github.com/mattpocock/skills/blob/main/skills/engineering/improve-codebase-architecture/INTERFACE-DESIGN.md).

Uses the vocabulary in [language.md](language.md) — **module**, **interface**, **seam**, **adapter**, **leverage**.

## When to invoke this protocol

Run this only when the user wants to compare alternatives — typically after `/dg:grill-me` has surfaced a real ambiguity in the design tree (e.g. "should this be a port or an internal seam?", "should the interface stream events or batch results?"). For obvious single-design candidates, skip.

## Process

### 1. Frame the problem space

Before spawning sub-agents, write a user-facing explanation of the problem space for the chosen candidate:

- The constraints any new interface would need to satisfy.
- The dependencies it would rely on, and which category they fall into (see [deepening.md](deepening.md)).
- A rough illustrative code sketch to ground the constraints — not a proposal, just a way to make the constraints concrete.

Show this to the user, then immediately proceed to Step 2. The user reads and thinks while the sub-agents work in parallel.

### 2. Spawn sub-agents

Spawn 3–4 sub-agents in parallel using the Agent tool. Each must produce a **radically different** interface for the deepened module.

Use `subagent_type="general-purpose"` for each (or a language-specific type when the codebase is single-language: `js`, `csharp`, `python`, `shell`). Send all calls in a single message so they run concurrently.

Prompt each sub-agent with a separate technical brief (file paths, coupling details, dependency category from [deepening.md](deepening.md), what sits behind the seam). The brief is independent of the user-facing problem-space explanation in Step 1. Give each agent a different design constraint:

- **Agent 1:** "Minimize the interface — aim for 1–3 entry points max. Maximize leverage per entry point."
- **Agent 2:** "Maximize flexibility — support many use cases and extension."
- **Agent 3:** "Optimize for the most common caller — make the default case trivial."
- **Agent 4** *(if cross-seam dependencies exist):* "Design around ports & adapters for cross-seam dependencies."

Include both [language.md](language.md) vocabulary and `.agents/monolith.md` vocabulary in the brief so each sub-agent names things consistently with the architecture language and the project's domain language.

Each sub-agent outputs:

1. **Interface** — types, methods, params, plus invariants, ordering constraints, error modes.
2. **Usage example** showing how callers use it.
3. **What the implementation hides** behind the seam.
4. **Dependency strategy and adapters** (see [deepening.md](deepening.md)).
5. **Trade-offs** — where leverage is high, where it's thin.

### 3. Present and compare

Present designs sequentially so the user can absorb each one, then compare them in prose. Contrast by:

- **Depth** — leverage at the interface.
- **Locality** — where change concentrates.
- **Seam placement** — where you can swap behavior.
- **Test surface** — how a test would exercise the deepened module.

After comparing, **give your own recommendation**: which design you think is strongest and why. If elements from different designs would combine well, propose a hybrid. Be opinionated — the user wants a strong read, not a menu.

## Output

The chosen design (single or hybrid) becomes the seed for the rest of the `/dg:refactor` step 4 conversation. From there:

- The design summary written at step 5 captures the chosen interface, dependency strategy, and migration path.
- `/dg:kick` consumes that summary as the request when the user parks the design.
