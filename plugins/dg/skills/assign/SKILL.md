---
name: assign
description: Pick the best-fit primary engineering agent (plus any QA agents) for a piece of work. Given a prose description — or nothing at all — recommend and print, writing nothing. Given a `/dg:spec` spec path, write the picks into `slices[].agents` frontmatter instead, one per slice. Reads the live agent roster so picks always reflect current capability.
---

# Skill: assign

Pick the best-fit primary engineering agent, plus any QA agents, for a piece of work. One pass, declarative.

Annotating the slices of a `/dg:spec` spec is one *application* of that pick — the one that persists its answer — not the
premise. Most work has no spec bundle anywhere near it, and "who should do this?" is a valid question on its own.

First run: install or refresh the CLI when it is missing or too old. Every later call uses the literal path, so each Bash call works alone:

```bash
~/.dg/bin/dg-skills spec --help >/dev/null 2>&1 ||
  curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.16.0/pkg/skills-cli/bootstrap.sh | sh -s -- --cli-only
```

## Invocation

| Form                            | Effect                                                                      |
| ------------------------------- | --------------------------------------------------------------------------- |
| `/dg:assign`                       | Recommend agents for the task at hand in this conversation. Writes nothing. |
| `/dg:assign <work description>`    | Recommend agents for the described work. Writes nothing.                    |
| `/dg:assign <spec-path>`           | Read spec, pick agents per slice, write back to frontmatter.                |
| `/dg:assign --dry-run <spec-path>` | Print the proposed YAML block. Do not write.                                |
| `/dg:assign --force <spec-path>`   | Re-assign even if `status: complete` or slices already have `agents:`.      |

## Dependency direction

`/dg:spec`, `/dg:prd`, `/dg:sdlc`, `/dg:kick`, and `/dg:polish` depend on `/dg:assign`. `/dg:assign` depends on none of them and never
requires their artifacts.

This skill is the **single owner** of agent-picking. `/dg:spec` plan-mode finalization, `/dg:sdlc` step 3, `/dg:pickup` (via
`/dg:spec -s`), and `/dg:prd` (front-loaded) each call it with a spec path; `/dg:polish` reuses only the heuristics table below.
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

1. **Load roster.** Run `~/.dg/bin/dg-skills spec roster` — one call, emits the live capability list as compact `name<TAB>description`
   lines (`~/.dg/bin/dg-skills spec roster --full` appends each agent's first prose paragraph). Prefer this over globbing
   the agents directory and reading each file.
2. **Pick.** For the work in hand (standalone) or each unassigned slice (spec mode), choose:
   - `primary` — one agent. The dominant language/domain wins. Default to a generalist (`dg:shell` or no assignment +
     warning) only if nothing fits.
   - `qa` — zero or more. Add `dg:qa-code` for non-trivial logic, `dg:qa-perf` for hot paths / large data, `dg:qa-devops` for
     CI/Docker/Terraform touches, `dg:qa-writer` for test-authoring work, `dg:reviewer` for cross-cutting refactors,
     `dg:security` for auth/secrets/crypto/PII.
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

- C# / .NET / EF Core / Dapper → `dg:csharp`
- Python / Flask / SQLAlchemy / pandas / pytest → `dg:python`
- TypeScript / React / Next.js / Node / Jest → `dg:js`
- Bash / ZSH / POSIX scripts / shell automation → `dg:shell`
- Terraform / Docker / GitHub Actions / AWS / CI-CD → `dg:devops`
- Snowflake / migrations / schema design / query tuning → `dg:dba`
- Docs / README / Mermaid / ADRs → `dg:lore`
- Architecture deep-dives (rare, usually as QA not primary) → `dg:arch`

Work that's clearly QA-only (writing tests against existing code) takes `dg:qa-writer` as **primary**, not as QA. Use
judgment.

## Routing

| Task | Read |
|---|---|
| Standalone-mode steps + output contract (no spec path — the default) | `references/standalone-mode.md` |
| Spec-annotation-mode steps + output contract (spec path given) | `references/spec-mode.md` |
| Escalating a hard call without upgrading the whole primary/effort pick | `references/edge-cases.md` |
| Delegating a slice to an external CLI backend (`/dg:proxy`) instead of a Claude agent | `references/edge-cases.md` |
| Handling a bad input (typo'd path, unparseable frontmatter, no `slices[]`) | `references/edge-cases.md` |
