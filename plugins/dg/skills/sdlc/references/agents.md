# Execution Agents — Directives & Protocols

Canonical agent guide for the execution lifecycle. Planning-side agent guidance (roundtable, foreman, spec review) lives in `/dg:spec`'s references; this file covers everything execution-side.

## Stage roster

| Stage | Agent | Model | Focus |
|---|---|---|---|
| Red / Green | **qa-writer** | sonnet | Failing tests from Contracts (red), coverage gaps (green) |
| Yellow (engineering) | `slices[].agents.primary` — picked by `/dg:assign` | per-agent pin | Full vertical slice: data → logic → API → UI |
| MiniQA | **wave** + `slices[].agents.qa[]` + **security** (when slice flags `securitySensitive`) | haiku / varies | Light review + checkpoint audit |
| Correction | responsible engineering agent or **qa-writer** | as assigned | Fix routed findings only |
| Final review | **reviewer**, **qa-perf**, **qa-devops**, **security** | sonnet | Style, logic, coverage, perf, build, OWASP |
| Docs | **lore** | sonnet | Doc comments, README |
| Full-audit | **wave** | haiku | Checkbox audit |

Model/effort tiering for wave stages is pinned in-script (`modelFor` / `EFFORT_BY_MODEL` in `templates/slice-wave.workflow.js` — the single source of truth for the tier→effort default); `slices[].agents.effort` overrides per slice.

## Common Directives

Inject these into **every** agent prompt (expand `[Common directives.]` in templates):

1. **School files:** Read `.agents/school/<topic>.md` if it exists (see topic map below). Skip if missing.
1. **MCP tools:** "Required tools (from spec frontmatter): [tools map]. Use these — fallback to built-in ONLY if MCP unavailable."
1. **File discovery:** Check `.agents/paths.md` first — stop if answer is there. Prefer LSP if available. Use fff-ai MCP if needed. Grep as last resort.
1. **Project vocabulary:** Read `.agents/monolith.md` if it exists (skip if missing). Use the project's canonical terms verbatim and avoid the listed aliases. Specs and implementation must speak the project's dialect.
1. **Real-sink test fidelity:** When code routes output to a *specific* destination — stdout vs stderr, a file named by an env var, a particular stream, an HTTP response body, a log target — at least one test MUST exercise the **real** sink, not only an in-memory double/buffer. A double captures *what* was written but never *where*, so wrong-sink bugs slip through every buffer assertion. (Canonical miss: a GitHub Actions `::error::` workflow command written to the `$GITHUB_STEP_SUMMARY` file instead of stdout — GitHub only parses workflow commands from stdout, so no annotation is ever produced, yet a buffer-based test that asserts the string was "written" passes.) Test-writers: add the real-sink test. Reviewers: flag any I/O-routing code whose only coverage is through a test double.

### School topic map

| File | Read by |
|---|---|
| `engineering.md` | engineering agents |
| `quality.md` | reviewer, wave, qa-writer |
| `performance.md` | qa-perf |
| `infrastructure.md` | qa-devops |
| `security.md` | security |
| `tooling.md` | lore |

## Scoped reading

- **qa-writer Red:** Slice Testing Criteria (start with `### Contracts`) + school topic + `paths.md`. No implementation exists. \[IF slice > 1: read `## Slice Summaries`.\]
- **Slice engineering (Yellow):** Slice spec section + test files from Red + school topic + `## Slice Summaries`. Implement full slice, run tests until pass.
- **qa-writer Green:** Slice Testing Criteria + implementation files from Yellow + school topic + `paths.md`. \[IF slice > 1: read `## Slice Summaries`.\]
- **Wave (MiniQA):** Changed-file list + slice spec section + school topic. In correction re-runs: corrected files only. Audit slice checkboxes (skip Issues Remediation).
- **Correction:** Relevant slice section + grouped findings + files to fix only.
- **Final reviewers:** Full spec (including Issues Remediation) + all changed files since branch base + school topic + `paths.md`.
- **Wave full-audit:** All spec checkboxes. Skip Issues Remediation.
- **Lore (docs):** Spec overview (Purpose, Scope, Slice headings) + changed files + existing docs + school topic.

## Agent Notes Protocol

Inter-slice communication for things the next slice's agents need to know but that don't belong in the spec's structured sections. Two channels — pick the right one:

| Marker | Routes to | Survives `/compact`? | Use for |
|---|---|---|---|
| `[NOTE-DURABLE] <text>` | `## Agent Notes` section appended to spec file | YES (spec is source of truth) | Lock patterns, schema quirks, hidden invariants, cross-cutting constraints the next slice MUST know |
| `[NOTE-SCRATCH] <text>` | the run's `SCRATCH_PATH` scratchpad | NO (ephemeral) | Debug logs, intermediate findings, dead-end exploration, "I tried X and it didn't work because Y" |

**Routing:** within the slice-wave workflow, each agent's markers are collected into the slice's structured `notes` return (`durable[]` / `scratch[]`); the orchestrator routes them during per-slice post-processing (engineering.md 4.3). Both channels are append-only. One scratchpad per spec (slice number inferred from frontmatter `current_slice`).

**Reading:** slice engineering agents (slice > 1) read `## Agent Notes` from the spec automatically. The scratchpad is optional reading — slice agents may read it for context; final reviewers receive it in their briefing.

## Output formats

- **Wave (MiniQA):** `## Review Findings` (`file:line — issue`) + `## Checkpoint` (unchecked list or "all complete").
- **Final review:** `[CRITICAL|HIGH|MEDIUM|LOW] file:line — issue` (CWE for security). If clean: "clean".
- **Wave full-audit:** `- [ ] Section > item` or "all complete".
- **Spec ambiguity (all):** `[SPEC] section — ambiguity`.
- **Test dispute (engineering):** `[TEST] test_name — suspected misinterpretation: rationale`.

Inside the slice-wave workflow these map into the forced return schema (deferrals/notes/findings) — see the return contract in engineering.md 4.2.

## Template lookup

Load only the template needed for the current stage.

| Stage | Template |
|---|---|
| Red | `templates/qa-writer-red.md` |
| Yellow | `templates/slice-engineering.md` (or `templates/slice-engineering-proxy.md` when `agents.proxy` set) |
| Green | `templates/qa-writer-green.md` |
| MiniQA / Full-audit | `templates/wave.md` |
| Correction | `templates/correction.md` |
| Final review | `templates/final-review.md` |
| Docs | `templates/lore.md` |
