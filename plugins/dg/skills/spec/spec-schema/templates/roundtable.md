# Roundtable Templates (Phase 3b)

All agents launch in parallel. Each receives the user-approved plan path **and** the discovery context bundle from Phase 3b.a1. **Design** is only dispatched when `FRONTEND_SCOPE=true` (set in Phase 1.e1).

## Sub-interview protocol (applies to ALL agents below)

Each agent runs a mini grill-me-style sub-interview against the **orchestrator** (not the user). The orchestrator answers from the discovery context bundle, the plan, and the codebase. Only when an answer requires user-only intent does the agent escalate.

1. **Read the discovery context bundle FIRST** (`$(~/.dg/bin/dg-skills stash spec <feature_snake_case>-roundtable-context.md)` — the orchestrator passes the resolved path in your launch prompt). Every `[DECIDED]` and `[ASSUMED]` from Phase 1 is settled — do not re-litigate. Recommendations that contradict a `[DECIDED]` item will be dropped by the orchestrator's pre-triage.
2. **Read the plan** at `<plan_path>` and the relevant portion of the codebase for your domain.
3. **Sub-interview the orchestrator.** Form 1–4 targeted questions per concern area. Ask the orchestrator (the calling agent) by emitting them in your transcript as `Q: …`. The orchestrator will respond inline with `A: …` from discovery context + code reads. Use 1–3 rounds max — you are critiquing, not redesigning.
4. **Record** each interview turn as `[DECIDED — sub]` (orchestrator answered conclusively), `[ASSUMED — sub]` (best-effort answer, low confidence), or `[OPEN — escalate]` (only the user can answer).
5. **Emit recommendations** in three flavors:
   - `N. [AREA] recommendation — rationale` — standard edit the orchestrator can apply to the plan.
   - `N. [OPEN — escalate] question — option-A / option-B [/ option-C]` — surface to user in Phase 3c with your recommended option listed first.
   - `N. [PROTOTYPE] question — option-A / option-B [/ option-C]` — hands-on validation needed (UI shape, state machine, API ergonomics, interaction flow). Phase 3c routes through the Phase 1.h prototype budget. Use sparingly — only when reading words won't settle it.
6. Output the sub-interview decision log first, then numbered recommendations. If no issues: `"no recommendations"`.

## Reviewer

> [Common directives.] Run the **sub-interview protocol** above. Review the draft plan at `<plan_path>` for: **architecture** (are vertical slices well-bounded? dependency graph sound?), **feasibility** (can each slice be implemented independently?), **completeness** (missing acceptance criteria? gaps in scope?), **risk** (integration risks between slices? migration concerns?). State-machine-shaped slices are prime `[PROTOTYPE]` candidates.

## QA-Perf

> [Common directives.] Run the **sub-interview protocol** above. Review the draft plan at `<plan_path>` for performance implications: **query patterns** (N+1 risks, unbounded queries), **data volume** (pagination, batch limits), **concurrency** (blocking calls, thread safety), **memory** (large object graphs, caching), **API design** (chatty vs chunky, payload sizes). API-shape trade-offs (chatty vs chunky, batch vs stream) are `[PROTOTYPE]` candidates when the ergonomics aren't obvious from the plan.

## Security

> [Common directives.] Run the **sub-interview protocol** above. Review the draft plan at `<plan_path>` for security: **auth** (missing auth on endpoints, privilege escalation), **input validation** (injection vectors), **data exposure** (sensitive fields, PII logging), **secrets** (hardcoded values, missing encryption), **dependencies** (known CVEs), **OWASP Top 10**. Output uses `(CWE if applicable)` in the rationale. Security findings are almost never `[PROTOTYPE]` — prefer `[AREA]` (clear fix) or `[OPEN — escalate]` (policy decision).

## Design (only if `FRONTEND_SCOPE=true`)

> [Common directives.] Run the **sub-interview protocol** above. Review the draft plan at `<plan_path>` for UX/UI surface concerns only — do NOT cross into architecture, performance, or security territory (other reviewers cover those). Evaluate: **simplicity** (is the flow doing more than the user's job requires?), **flow** (necessary vs. accidental friction; empty/error/edge states; what happens *after* success?), **copy** (do labels promise what they deliver? is product vocabulary used verbatim?), **affordance** (will the user know what to do without a tutorial?), **cut candidates** (every screen, field, step, setting, and message should justify its existence). UX layout / interaction flow trade-offs are prime `[PROTOTYPE]` candidates — when two flows both *sound* reasonable, ship variations and let the user pick. Areas for `[AREA]` recommendations: SIMPLICITY, FLOW, COPY, AFFORDANCE, CUT-CANDIDATE.
