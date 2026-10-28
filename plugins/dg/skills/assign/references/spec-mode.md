# Spec-annotation mode

1. **Load spec.** `Read` the spec file. The authoritative slice list is the frontmatter **`slices[]` array** (each item:
   `id`, `name`, `depends_on`, `files`, and the `agents` object to fill). Read each slice's body section
   (`### Slice <n>` / its Engineering block) for extra context when present — but drive iteration off `slices[]`, not a
   body heading.

1. **Gate.**

   - If `status: complete` and no `--force`: refuse, print why, stop.
   - For each slice that already has `agents.primary` set: skip unless `--force`. (Idempotency.) A slice with `primary`
     but no `effort` override is not touched on a plain re-run — absence is the expected steady state, not a gap to
     backfill.

1. **Pick and validate.** The common steps (SKILL.md § Common — pick the agents), per remaining slice.

1. **Ask about low-confidence slices only.** Give each slice with `confidence: low` exactly one `AskUserQuestion`: the
   candidate primaries as options, your recommendation first and marked as recommended. Write the answer as `primary` and
   set that slice's `confidence` to `high`. When every slice is `high`, ask nothing and go straight to the write. Never
   ask about effort, QA agents or a `high` slice.

1. **Write.** Mutate frontmatter so each slice gets:

   ```yaml
   agents:
     primary: <agent-name>
     confidence: <high|low>
     effort: <low|medium|xhigh>   # omit key unless overriding the tier default in model-tiers.json
     qa: [<agent>, <agent>]       # omit key if empty
   ```

   Preserve all other frontmatter exactly. Use `Edit` with a tight `old_string` per slice to avoid clobbering.

1. **Report.** Print a one-line summary per slice: `s0 → devops (qa: qa-devops)`, or
   `s1 → dba [effort: xhigh override] (qa: security)` when `effort` was set.

## Output

The downstream readers are `/dg:spec` plan-mode step 7 and the execution agents reading the plan. They expect exactly:

```yaml
slices:
  - name: s0-foundation
    agents:
      primary: csharp
      confidence: high
      qa: [qa-code, reviewer]
  - name: s1-migration
    agents:
      primary: dba
      confidence: high
      effort: xhigh   # only present because this slice overrides dba's tier default
      qa: [security]
```

`primary` is a string (one agent). `confidence` is `high` or `low`; after the question step it is `high` on every written slice unless the user declined to answer. `effort` is optional — one of `low`/`medium`/`xhigh` (never `high`) — and present
**only** when it overrides the tier default in `model-tiers.json`; omit it for the common case. `qa`
is a list (zero or more). No other keys under `agents:` besides `primary`, `confidence`, `effort`, `qa`, `proxy`, `proxy_skills`.
