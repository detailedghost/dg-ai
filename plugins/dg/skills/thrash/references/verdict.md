# Verdict rule

Spice sets how many findings per tier the PR can have. One more than the limit requests
changes. Otherwise approve. A blank cell has no limit.

Only open findings count. Clearing never resolves a thread. When no finding is open, the
verdict is approve, in every round. `references/findings.md` defines "open".

| Spice | Critical | High | Medium | Low |
|---|---|---|---|---|
| 1 | 0 | 4 | | |
| 2 | 0 | 1 | | |
| 3 | 0 | 0 | 4 | |
| 4 | 0 | 0 | 2 | |
| 5 | 0 | 0 | 0 | 4 |

Nits never fail a review. Pre-existing findings and improvements never count either.
`--comment` replaces the event. Spice never moves a tier.
`VERDICT_LIMITS` in `pkg/skills-cli/src/thrash/core.ts` owns these numbers.

