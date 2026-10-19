# Templates

## CLAUDE.md Template (15-25 lines)

CLAUDE.md is a minimal stub. AGENTS.md is the authority.

```markdown
# <Project Name>

<1-2 sentence description.>

## Commands

| Purpose | Command |
|---------|---------|
| Build   | `<build command>` |
| Test    | `<test command>` |
| Lint    | `<lint command>` |
| Dev     | `<dev server command>` |

For architecture, conventions, domain context, and agent workflow, read `AGENTS.md`.
```

Rules:
- 15-25 lines max
- No conventions here — those live in AGENTS.md
- No directory trees, no code examples, no architecture
- The only actionable content is the commands table
- Final line is always a pointer to AGENTS.md

## AGENTS.md Template (30-60 lines)

AGENTS.md is the primary doc agents read. It carries conventions and routes to all deep context.

```markdown
# AGENTS.md — <Project Name>

<1-2 sentence project summary.>

<!-- agent-seed:start:packages -->
## Packages

| Package | Path | AGENTS.md |
|---------|------|-----------|
| <Name>  | `<path>/` | `<path>/AGENTS.md` |
<!-- agent-seed:end:packages -->

## Key Conventions

- <Convention 1 — specific, actionable, one line>
- <Convention 2>
- <Up to 10 max>

<!-- agent-seed:start:references -->
## References

On-demand deep context (read these when you need them, not upfront):

| File | Contents |
|------|----------|
| `.agents/references/architecture.md` | System design, component map, data flow |
| `.agents/references/patterns.md` | Code conventions, idioms, examples |
| `.agents/references/directory-tree.md` | Annotated project tree |
| `.agents/references/domain.md` | Domain model, terminology |
| `.agents/monolith.md` | Project vocabulary (terms, conventions, patterns, ambiguities), when the file exists. Consult it before naming things |
| `.agents/paths.md` | Repo file/directory lookup — read before exploring codebase |
<!-- agent-seed:end:references -->

<!-- agent-seed:start:specs -->
## Specs & Learnings

- **Specs:** `.agents/spec/` (feature bundles written by `/kick` and resumed by `/pickup`)
- **Learnings:** `.agents/school/` (topic-cluster format — any agent may write here following the format in each file's header)
<!-- agent-seed:end:specs -->

## Agent Workflow

For feature development, use `/kick "<request>"` to park a plan and `/pickup` to implement it. Both read `.agents/school/` and use `.agents/spec/`.
```

Notes:
- Omit the Packages section entirely for single-package projects.
- The References table lists only files that actually exist.
- `<!-- agent-seed:start/end -->` markers let future runs update managed sections without touching custom content.
- Conventions section is NOT wrapped in markers — it's hand-maintained after initial seed.

## Per-Package AGENTS.md (monorepo, ~10 lines)

```markdown
# AGENTS.md — <Package Name>

<1-sentence description of this package.>

## References

See root `.agents/references/` for architecture, patterns, and domain context.
See root `AGENTS.md` for conventions, specs, and learnings locations.
```

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

Feature planning bundles written by `/kick` live under `.agents/spec/`:

```
.agents/spec/
  <NNN>_<slug>/           # Feature bundle directory
    plan.md               # Durable spec (read by /pickup)
    context.md            # One-page summary (read by /pickup)
  todo/                   # Parking area for /prd deliverables
    <prd-slug>/
      plan.md             # PRD-parked spec
```

`plan.md` and `context.md` are the files `/pickup` implements from. Extra notes may sit beside them; `/pickup` does not require them.

## School Stub Template

```markdown
<!-- [Topic] learnings. Max 100 lines. Prune oldest when full. -->
<!-- Format: - [YYYY-MM-DD] one learning per line, concise and actionable -->
<!-- Any agent may add entries. Prune the oldest lines when the file passes 100 lines. -->
```

Three comment lines. The stub exists so planning agents don't error on missing files, and any agent reading the file immediately knows the contract.
