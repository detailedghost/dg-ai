---
name: hunt
description: Structured codebase bug hunt and root-cause diagnosis. Triages the issue, runs parallel evidence-gathering agents, synthesizes a diagnosis report. Use when something "fails", "broke", "doesn't work", or needs diagnosis.
---

# /dg:hunt — Codebase Bug Hunt & Diagnosis

Cross-examine the codebase — not the user — until the root cause is found or confidently narrowed. You are a diagnostician, not an interviewer.

**Usage:** `/dg:hunt [description of the failure or issue]`

## When to use /dg:hunt vs /dg:grill-me

| Signal | Skill | Why |
|--------|-------|-----|
| Something is broken/failing/wrong | `/dg:hunt` | Interrogate the **code** for evidence |
| Designing something new or changing behavior | `/dg:grill-me` | Interrogate the **user** for intent |
| Hunt surfaces a design gap | `/dg:hunt` → recommend `/dg:grill-me` | Diagnosis done — now design the fix |
| Design interview hits an existing bug | `/dg:grill-me` → recommend `/dg:hunt` | Pause design — diagnose first |

## Reference Files (lazy-load)

| File | When to read |
|------|-------------|
| [references/protocol.md](references/protocol.md) | At session start — triage, agent routing, hunt protocol, report format |

## Core Principles

1. **Evidence over speculation.** Every claim needs a file path, line number, log snippet, or git SHA. No hand-waving.
2. **Parallel when orthogonal.** If two hunt threads don't depend on each other, launch agents concurrently. Never launch redundant/overlapping agents.
3. **Triage first.** Classify the domain before diving in — wrong agent wastes tokens.
4. **Minimum reads.** Follow fff → rg → Grep hierarchy. Stop searching after you have enough file paths — read the code.
5. **Converge fast.** Target diagnosis in ≤3 rounds. If round 3 is inconclusive, report what you know and what's still unknown.
