---
name: assign
description: Pick the best-fit primary engineering agent (plus any QA agents) for a piece of work. Given a prose description — or nothing at all — recommend and print, writing nothing. Given a `/spec` spec path, write the picks into `slices[].agents` frontmatter instead, one per slice. Reads the live agent roster so picks always reflect current capability.
---

# Skill: assign

Pick the best-fit primary engineering agent, plus any QA agents, for a piece of work. One pass, declarative.

Annotating the slices of a `/spec` spec is one *application* of that pick — the one that persists its answer — not the
premise. Most work has no spec bundle anywhere near it, and "who should do this?" is a valid question on its own.

Resolve the CLI before using the commands below:

```bash
DG="${DG_HOME:-$HOME/.dg}/bin/dg-skills"
if [ ! -x "$DG" ]; then
  LOCAL_BOOTSTRAP="${CLAUDE_PLUGIN_ROOT:-}/pkg/skills-cli/bootstrap.sh"
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "$LOCAL_BOOTSTRAP" ]; then
    sh "$LOCAL_BOOTSTRAP"
  else
    curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.15.0/pkg/skills-cli/bootstrap.sh | sh
  fi
fi
```

## Invocation

| Form                            | Effect                                                                      |
| ------------------------------- | --------------------------------------------------------------------------- |
| `/assign`                       | Recommend agents for the task at hand in this conversation. Writes nothing. |
| `/assign <work description>`    | Recommend agents for the described work. Writes nothing.                    |
| `/assign <spec-path>`           | Read spec, pick agents per slice, write back to frontmatter.                |
| `/assign --dry-run <spec-path>` | Print the proposed YAML block. Do not write.                                |
| `/assign --force <spec-path>`   | Re-assign even if `status: complete` or slices already have `agents:`.      |

## Dependency direction

`/spec`, `/prd`, `/sdlc`, `/kick`, and `/polish` depend on `/assign`. `/assign` depends on none of them and never
requires their artifacts.

This skill is the **single owner** of agent-picking. `/spec` plan-mode finalization, `/sdlc` step 3, `/pickup` (via
`/spec -s`), and `/prd` (front-loaded) each call it with a spec path; `/polish` reuses only the heuristics table below.
Do not reimplement the pick-and-write logic elsewhere; call this.

## Dispatch

Decided by the argument alone, before anything else runs:

1. **No argument** → standalone mode. The work is whatever this conversation is currently doing.
2. **Argument resolves to an existing file** → spec-annotation mode.
3. **Argument is path-shaped but no such file exists** → stop, print the path. Path-shaped means it contains `/`, ends
   in `.md`, or starts with `/`, `./`, or `~`. A typo'd spec path must not degrade into advisory mode: that silently
   answers a question nobody asked and skips the write the caller was waiting on.
4. **Anything else** → standalone mode; the argument is the work description.

Nothing is both a valid spec path and a sensible prose description, so the split is unambiguous. Don't re-litigate it.

`--dry-run` and `--force` are spec-mode only — both describe writes, and standalone mode never writes. Passing either
without a spec path is an error, not a no-op.

## Algorithm

### Common — pick the agents

1. **Load roster.** Run `"$DG" spec roster` — one call, emits the live capability list as compact `name<TAB>description`
   lines (`"$DG" spec roster --full` appends each agent's first prose paragraph). Prefer this over globbing
   the agents directory and reading each file.
2. **Pick.** For the work in hand (standalone) or each unassigned slice (spec mode), choose:
   - `primary` — one agent. The dominant language/domain wins. Default to a generalist (`shell` or no assignment +
     warning) only if nothing fits.
   - `qa` — zero or more. Add `qa-code` for non-trivial logic, `qa-perf` for hot paths / large data, `qa-devops` for
     CI/Docker/Terraform touches, `qa-writer` for test-authoring work, `reviewer` for cross-cutting refactors,
     `security` for auth/secrets/crypto/PII.
   - `effort` — leave unset unless this work needs to deviate from `primary`'s model-tier default. The default itself
     lives in one place, `EFFORT_BY_MODEL` in [`sdlc/references/templates/slice-wave.workflow.js`](../sdlc/references/templates/slice-wave.workflow.js) (currently
     `haiku→low, sonnet→medium, opus→xhigh`) — the workflow applies it automatically when `effort` is absent, so
     emitting the default value would just restate derivable state. Only set `effort` to override that default upward
     for the hardest-call case at its tier (cross-cutting architecture, security-sensitive design, ambiguous
     trade-offs on an otherwise-`sonnet` primary) — never emit `high`, the table skips it.
3. **Validate.** Every name must exist in that roster. Mismatch → fail loud, write nothing.

Then run the mode-specific steps for whichever mode `Dispatch` picked — see Routing below.

## Picking heuristics

Match the work against roster descriptions. Strong signals beat weak ones:

- C# / .NET / EF Core / Dapper → `csharp`
- Python / Flask / SQLAlchemy / pandas / pytest → `python`
- TypeScript / React / Next.js / Node / Jest → `js`
- Bash / ZSH / POSIX scripts / shell automation → `shell`
- Terraform / Docker / GitHub Actions / AWS / CI-CD → `devops`
- Snowflake / migrations / schema design / query tuning → `dba`
- Docs / README / Mermaid / ADRs → `lore`
- Architecture deep-dives (rare, usually as QA not primary) → `arch`

Work that's clearly QA-only (writing tests against existing code) takes `qa-writer` as **primary**, not as QA. Use
judgment.

## Routing

| Task | Read |
|---|---|
| Standalone-mode steps + output contract (no spec path — the default) | `references/standalone-mode.md` |
| Spec-annotation-mode steps + output contract (spec path given) | `references/spec-mode.md` |
| Escalating a hard call without upgrading the whole primary/effort pick | `references/edge-cases.md` |
| Delegating a slice to an external CLI backend (`/proxy`) instead of a Claude agent | `references/edge-cases.md` |
| Handling a bad input (typo'd path, unparseable frontmatter, no `slices[]`) | `references/edge-cases.md` |
