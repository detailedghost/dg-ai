---
covers: ["pkg/channel-review/src/engine.ts", "pkg/channel-review/src/runners/**", "pkg/channel-review/__tests__/core-engine-fallback.spec.ts", "docs/DEVELOPER.md"]
---

[ADR 0019](../../docs/adr/0019-review-execution-context.md)

- Pass fresh JSON in `THRASH_EXECUTION_CONTEXT` on each review attempt: origin, backend, optional model and modelSource (requested, configured or default).
- Drop inherited `THRASH_*` values from the child environment.
- Use origin daemon for daemon reviews. Default direct runner calls to manual.
- Never infer origin from the presence of a daemon.
- Keep unresolved reviewer models explicit. Never report the parent model as every reviewer.
- Retry a Claude review that returns CR-207 once with the configured fallback, after its readiness probe succeeds.
- Keep fallback off when `runner.fallback` is absent. Turn it on with `"fallback": "codex"`.
- Give the fallback a fresh context, its own model default and log, and the remaining original timeout.
- Never carry a requested Claude model or inherited reviewer evidence into the fallback.
- Reply to the triggering chat request that Claude is out of tokens and name the fallback. Send no owner DM for a review fallback.
- Never retry on authentication errors, cancellation or write tasks.
- Show configured Grok models without claiming a resolved runtime ID. Check Grok readiness with models and inspect --json only.
- Deploy a compatible thrash helper and skill with runner changes.
