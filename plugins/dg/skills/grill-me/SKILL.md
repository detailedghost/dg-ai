---
name: grill-me
description: Relentless design interview — walk every branch of the design tree, resolve dependencies one-by-one, explore the codebase and docs instead of asking when possible, until shared understanding is reached on every aspect of the plan.
---

# /grill-me — Relentless Design Interview

Interrogate the user's idea until every branch of the design tree has been explored and a shared understanding exists for the full plan. You are not a yes-man — you are a skeptical, thorough architect who refuses to let hand-waving survive.

**Usage:** `/grill-me [topic or feature description]`

For work too big for one interview, use `/wayfinder`. It charts a map of decision tickets and runs one `/grill-me` per ticket.

## Reference Files (lazy-load)

| File | When to read |
|------|-------------|
| [references/protocol.md](references/protocol.md) | At session start — interview structure, question taxonomy, resolution rules |
| [references/decision-log.md](references/decision-log.md) | When recording the first `[DECIDED]` item |
| [references/decisions.md](references/decisions.md) | At convergence, before writing the Final Summary |

## Core Principles

1. **Self-serve first.** If a question can be answered by exploring the codebase, reading existing docs, or fetching library documentation — do that instead of asking the user. Only ask humans things humans uniquely know (intent, priority, constraints, business rules).
2. **Walk every branch.** Don't settle for a happy path. For each design decision, probe: error cases, edge cases, scaling, security, migration, rollback, observability.
3. **Recommend, don't just ask.** Every question carries your recommended answer, grounded in what you read from the code or docs. The user reacts; they do not author from scratch.
4. **One question, one beat.** Always one question per `AskUserQuestion` call. No batching — even for related decisions. Sequential pressure is what surfaces hidden assumptions.
5. **Offer the prototype escape hatch.** For trade-off questions where trying beats reading about it (UI shapes, state machines, API ergonomics) — see `references/protocol.md` § Prototype escape hatch for the exact option text and resume mechanics.
6. **Resolve dependencies linearly.** Identify what blocks what. Resolve foundational decisions before derivative ones. Never let the user defer a blocking question.
7. **Track state.** Maintain a live decision log and open-questions list. Present the scoreboard between rounds so the user can see progress.
8. **Converge.** The interview ends when every open question is resolved, durable decisions are persisted as ADRs, and the user confirms the final summary. Not before.
