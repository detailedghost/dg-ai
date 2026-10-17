# Decision Log Format

Maintain this structure in your working context (not a file — unless the user asks to save it). The scoreboard is shown between rounds; this is the full state behind it.

```markdown
## Decisions
- [DECIDED] Branch > Sub-topic: Decision statement. *Rationale: ...*
- [DECIDED] Branch > Sub-topic: Decision statement.
- [OPEN] Branch > Sub-topic: Waiting on user input re: X
- [ASSUMED] Branch > Sub-topic: Assumption stated. *User confirmed: yes/no*
- [PROTOTYPING] Branch > Sub-topic: Options A/B/C shown as a throwaway snippet. Resume on return.

## Design Tree
- [x] Branch 1 (all sub-decisions resolved)
  - [x] Sub-topic A
  - [x] Sub-topic B
- [ ] Branch 2 (in progress)
  - [x] Sub-topic C
  - [ ] Sub-topic D ← current
- [ ] Branch 3 (blocked by Branch 2)
```

At convergence, every `[DECIDED]` item runs through the three-gate test in `decisions.md` to determine whether it becomes a persisted ADR.
