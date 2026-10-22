# Templates

## CLAUDE.md Template

CLAUDE.md holds one line, so Claude Code loads AGENTS.md with no extra read:

```markdown
@AGENTS.md
```

Commands live in `mise.toml` (`mise tasks` lists them) or the build scripts, not in CLAUDE.md.

## Root AGENTS.md Template (about 2.4K characters)

Every session loads this file, so it holds only what an agent cannot find on its own: where things are, and the
traps. Code style lives in `docs/code_standards.md`. Never repeat it here.

```markdown
# AGENTS.md — <Project Name>

<One line: what the repo is and its main stack.>

<!-- agent-seed:start:packages -->
## Packages

| Package | Path | AGENTS.md |
|---------|------|-----------|
| <Name>  | `<path>/` | `<path>/AGENTS.md` |
<!-- agent-seed:end:packages -->

## Rules

- Canonical rules: `docs/CONTRIBUTING.md`, `docs/code_standards.md`, `docs/code_review.md`.
- `mise run <task>` only (`mise tasks` lists them).
- <Trap: one terse line that stops a real mistake>
- Decisions: human ADRs in `docs/adr/`, agent rules in `.agents/decisions/` linking the ADR. Cite by number; never
  relitigate.

<!-- agent-seed:start:references -->
## References

Read on demand, not upfront:

| File | Contents |
|------|----------|
| `.agents/paths.md` | Repo file and folder lookup. Read before you explore the code |
| `.agents/references/architecture.md` | System design, component map, data flow |
| `.agents/references/domain.md` | Domain model, terms |
| `.agents/monolith.md` | Project vocabulary, when the file exists. Consult it before naming things |
<!-- agent-seed:end:references -->

<!-- agent-seed:start:specs -->
## Specs & Learnings

- Specs: `.agents/spec/` (`/dg:kick` parks a plan, `/dg:pickup` builds it).
- Learnings: `.agents/school/`. Follow the format in each file's header.
<!-- agent-seed:end:specs -->
```

Notes:
- Omit the Packages section for a single-package project.
- Rules are traps only: terse, one line each, dense technical words are fine. A rule a linter or test enforces does
  not belong here.
- The References table lists only files that exist.
- `<!-- agent-seed:start/end -->` markers let a later run update managed sections without touching the Rules.

## Per-Package AGENTS.md (monorepo, under about 3.5K characters)

```markdown
# AGENTS.md — <path>

<One line: what the package is.>
Code standards: `docs/code_standards.md`. Review rules: `docs/code_review.md`.

## Stack

- <framework, language version, key libraries, test runner>

## Commands

- Build, test, lint, format: `mise run <task>`, ...
- <how to run it locally, and any platform trap>

## Task templates

<Common task>:
1. <file or folder to change first>
2. <next step>

## Traps

- <one line each: what breaks and how to avoid it>

## References (read on demand)

| File | Contents |
|------|----------|
| `.agents/references/<pkg>-<topic>.md` | <one feature area: routes, env vars, jobs, entry points> |
```

Move feature detail (route lists, env var tables, job lists) to `.agents/references/<pkg>-<topic>.md`, one file per
topic, and link it from this table.

## .gitignore Entry

Append this line to `.gitignore` (create the file if missing). `.agents/` is local agent workspace — not project source — and should be gitignored by default.

```
.agents/
```

Only add once — check before appending. Skip entirely if `.agents/` is already tracked (`git ls-files .agents/` returns results); warn the user instead. If the user opts to check in `.agents/` at Step 3, remove this line (or add `!.agents/` override) before committing.

## .agents/paths.md Template

This file maps repo-specific locations so agents can find files without expensive codebase exploration. Populate it during Step 5 based on detected project structure.

```markdown
# Repo Paths
<!-- Agent file-discovery lookup. Read this before exploring the codebase. -->
<!-- agent-seed populates on first run. Update manually when structure changes. -->

## Source

| Area | Path |
|------|------|
| <e.g. API routes> | `<path>/` |
| <e.g. Components> | `<path>/` |
| <e.g. Shared types> | `<path>/` |

## Tests

| Area | Path | Pattern |
|------|------|---------|
| <e.g. Unit tests> | `<path>/` | `*.spec.ts` |

## Config

| File | Purpose |
|------|---------|
| <e.g. tsconfig.base.json> | <purpose> |
```

Rules:
- Keep it under 50 lines — it's a lookup table, not documentation
- Only include paths that actually exist
- Use `<placeholder>` for anything you can't detect — the user fills it in
- For monorepos, include per-package sections with the package name as header

## .agents/spec/ — Feature Spec Bundles

Feature planning bundles written by `/dg:kick` live under `.agents/spec/`:

```
.agents/spec/
  <NNN>_<slug>/           # Feature bundle directory
    plan.md               # Durable spec (read by /dg:pickup)
    context.md            # One-page summary (read by /dg:pickup)
  todo/                   # Parking area for /dg:prd deliverables
    <prd-slug>/
      plan.md             # PRD-parked spec
```

`plan.md` and `context.md` are the files `/dg:pickup` implements from. Extra notes may sit beside them; `/dg:pickup` does not require them.

## School Stub Template

```markdown
<!-- [Topic] learnings. Max 100 lines. Prune oldest when full. -->
<!-- Format: - [YYYY-MM-DD] one learning per line, concise and actionable -->
<!-- Any agent may add entries. Prune the oldest lines when the file passes 100 lines. -->
```

Three comment lines. The stub exists so planning agents don't error on missing files, and any agent reading the file immediately knows the contract.
