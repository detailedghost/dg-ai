# Target Structure & Mapping

## Target Layout

After spring-break runs, `.agents/school/` contains only:

```
.agents/school/
  engineering.md      <- dba, api, architecture, data-access, dotnet, csharp, react, nextjs, sql, snowflake
  quality.md          <- testing, coverage, code-quality, style, conventions, static-analysis
  performance.md      <- profiling, memory, async, optimization
  infrastructure.md   <- ci-cd, docker, terraform, aws, builds, deployment, pipeline
  security.md         <- vulnerabilities, auth, secrets, hardening, compliance
  product.md          <- specs, requirements, acceptance-criteria, domain, jira, workflows
  tooling.md          <- scripts, posix, bash, zsh, docs, readme, mermaid
  DEPS.md             <- dependency upgrade history (only if deps history exists)
```

## Topic File Format

```markdown
<!-- [Topic] learnings. Max 100 lines. Prune oldest when full. -->

- [YYYY-MM-DD] One learning per line, concise and actionable
```

Rules: Flat list. No sub-headings, no YAML frontmatter. One line per entry: `- [YYYY-MM-DD] description`. Max 100 lines. Comment on line 1 states topic and limit.

## DEPS.md Format

```markdown
<!-- Dependency upgrade history. Keep recurring issues + last 3 runs. Max 80 lines. -->

## Recurring Issues
- description of recurring issue

## YYYY-MM-DD
- package old -> new
- Breaking: what broke and how fixed
```

"Recurring Issues" section is permanent, always at top. Keep 3 most recent runs. Max 80 lines.

## Old-to-New Mapping

| Old file pattern | New file |
|---|---|
| `dba.md`, `backend.md`, `csharp.md`, `frontend.md`, `snowflake.md` | `engineering.md` |
| `qa.md`, `reviewer.md`, `wave.md`, `qa-writer.md` | `quality.md` |
| `qa-perf.md` | `performance.md` |
| `devops.md`, `qa-devops.md` | `infrastructure.md` |
| `security.md` | `security.md` |
| `product-spec.md`, `jira.md` | `product.md` |
| `shell.md`, `lore.md`, `docs.md` | `tooling.md` |
| `deps/*`, `DEPS.md` | `DEPS.md` |
| `LEARNINGS.md` (old consolidated format) | Split entries by topic into files above |

## Spec Artifact Migration

One-time per-project migration of retired `/create-spec` artifacts into `/spec`'s bundle layout.
Idempotent — re-running skips any bundle that already exists at its target path.

### Old → New Mapping

| Old path | New path |
|---|---|
| `.agents/create-specs/<NNN>_<slug>.md` | `.agents/spec/<NNN>_<slug>/plan.md` (+ synthesized `context.md`) |
| `.agents/todo/<NNN>_<slug>.md` | `.agents/spec/todo/<slug>/` |

### Target Layout (post-migration)

```
.agents/spec/
  <NNN>_<slug>/
    plan.md       <- moved verbatim from .agents/create-specs/<NNN>_<slug>.md
    context.md    <- synthesized via `~/.dg/bin/dg-skills spec context <bundle>`
  todo/
    <slug>/       <- moved from .agents/todo/<NNN>_<slug>.md
```

### Migration Rules

- The flat `<NNN>_<slug>.md` file IS the durable plan — move it as-is to `plan.md`; there's no
  `initial.md`/`roundtable/` sprawl to reconstruct.
- Preserve `NNN` from the old filename. Never renumber.
- Normalize known legacy quirks before validating: coerce a non-integer `current_slice` (e.g.
  `current_slice: done`) via `~/.dg/bin/dg-skills spec set <bundle>/plan.md current_slice 0`, and strip fields
  absent from `frontmatter-schema.yaml` (e.g. `prototypes_run`) directly from the frontmatter block.
- Run `~/.dg/bin/dg-skills spec validate <bundle>/plan.md` after normalizing. Surface any remaining violations in
  the report (SKILL.md Step 6) instead of fixing them silently — some legacy fields need a human call.
- After the move, run `~/.dg/bin/dg-skills spec context <bundle>` to produce `context.md` so `/spec -s <NNN>_<slug>`
  can pick the bundle up.
- If `.agents/spec/<NNN>_<slug>/plan.md` already exists, skip that bundle — already migrated, no-op.
- While merging school learnings (SKILL.md Step 3), also drop any entries that reference the retired
  `/create-spec` workflow — superseded by `/spec`.
- Ownership: spring-break creates spec bundles here for migration only, never edits one it didn't
  just migrate. Ongoing bundle authoring (new specs, `plan.md`/`context.md` updates) is `/spec`'s job.

## Protected Files (do NOT touch)

| File | Owner |
|---|---|
| `.agents/school/DEPS.md` | deps-upgrade |
| `.agents/paths.md` | agent-seed / manual |
