# agent-seed Workflow

Execute steps in order. Do not skip steps. Report progress after each.

## Step 1 — Read and Analyze

- Read `CLAUDE.md` (if exists)
- Read `AGENTS.md` (if exists)
- List `.agents/` directory tree (if exists)
- Scan project root for tech stack: `package.json`, `nx.json`, `turbo.json`, `*.sln`, `*.csproj`, `go.mod`, `Cargo.toml`, `pyproject.toml`, `pom.xml`
- Detect monorepo if: `nx.json`, `turbo.json`, `pnpm-workspace.yaml`, `lerna.json`, `packages/` with multiple `package.json`, or multiple `.sln`/`.csproj`
- Classify existing `.agents/` content by canonical destination
- Report: tech stack, monorepo Y/N, .agents/ state, CLAUDE.md line count

> **GATE:** Analysis complete. Proceed only after reporting findings.

## Step 2 — Backup

- Create `.agents/references/` if missing
- Write `.agents/references/CLAUDE.md.bak` with full original CLAUDE.md content
- If AGENTS.md exists, write `.agents/references/AGENTS.md.bak` too
- Confirm backups written before proceeding
- If neither file exists, skip backup but continue

> **GATE:** Backups confirmed (or skipped for new projects).

## Step 3 — Create .agents/ Structure

- Create `.agents/references/` if missing
- Create `.agents/spec/` if missing
- Create `.agents/school/` if missing
- For each of these 7 school files, create with stub if not present:
  - `engineering.md`, `quality.md`, `performance.md`, `infrastructure.md`, `security.md`, `product.md`, `tooling.md`
  - Stub format (3 lines):
    ```
    <!-- [Topic] learnings. Max 100 lines. Prune oldest when full. -->
    <!-- Format: - [YYYY-MM-DD] one learning per line, concise and actionable -->
    <!-- Any agent may add entries. Prune the oldest lines when the file passes 100 lines. -->
    ```
- Create `.agents/paths.md` if not present — this is a repo-specific file/directory lookup table that agents read before exploring the codebase. See templates.md for the template. Populate it during Step 5 using detected project structure.
- **Add `.agents/` to `.gitignore`** — local agent workspace, not project source:
  - If `.gitignore` exists, append `.agents/` if not already present
  - If `.gitignore` does not exist, create it with just `.agents/`
  - Do NOT add if `.agents/` is already tracked (i.e. `git ls-files .agents/` returns results) — warn instead and skip

> **GATE:** All directories, stub files, paths.md, and `.gitignore` entry exist.

## Step 4 — Migrate Existing .agents/ Content

- `prompt.md` or `PROMPT.md` -> append to `.agents/references/architecture.md`
- `specs/` -> rename to `.agents/spec/` (preserve contents)
- `learnings/` with topic-cluster content -> move each file into `.agents/school/` under the closest stub name, then prune to the stub's line cap
- `school/domains/`, `school/archive/` -> move still-relevant notes into the matching `.agents/school/` stub, then remove the old directories
- Any other non-canonical files -> report what they are and where they might belong
- Report each move made

> **GATE:** All migratable content moved. Non-canonical remnants reported.

## Step 5 — Populate References

Extract from CLAUDE.md AND existing AGENTS.md using the classification rules (see classification.md):
- Directory trees -> `directory-tree.md`
- Architecture/design content -> `architecture.md`
- Code examples and pattern explanations -> `patterns.md`
- Domain terminology and business rules -> `domain.md`

Also extract conventions from CLAUDE.md — these go into AGENTS.md (Step 7), not a reference file.

If `directory-tree.md` is empty after extraction, generate an annotated tree (3 levels deep, excluding `node_modules`, `bin`, `obj`, `.git`, `dist`, `build`, `.next`).

Each reference file format:
```markdown
# <Title>
<!-- seeded by agent-seed YYYY-MM-DD -->

<content>
```

If a reference file already has content, append after a `---` separator.

> **GATE:** Reference files populated. Conventions collected for Step 7.

## Step 6 — Rewrite CLAUDE.md

Build from the template in templates.md (15-25 lines):
- Project name: from `package.json` name, `.sln` filename, or directory basename (priority order)
- Description: preserve from original if concise (1-2 sentences); otherwise generate from tech stack
- Commands: detect from `package.json` scripts, `Makefile`, `*.csproj` build targets; use `<command>` placeholder for unknowns
- Final line: pointer to `AGENTS.md`

**No conventions in CLAUDE.md.** Those go in AGENTS.md.

Verify: 15-25 lines. If over 25, the description is too long.

> **GATE:** CLAUDE.md rewritten and within line budget.

## Step 7 — Create or Update AGENTS.md

AGENTS.md is the primary authority. It carries conventions + routes to all context.

- If AGENTS.md doesn't exist: write from template in templates.md
- If AGENTS.md exists: update only sections wrapped in `<!-- agent-seed:start/end -->` markers; preserve everything else (including hand-written conventions)
- Conventions section: populate from extracted conventions (Step 5) on first run. On subsequent runs, do NOT overwrite — conventions are hand-maintained after initial seed.
- For monorepos: create per-package `AGENTS.md` (simplified — no school section, references point to root `.agents/`)

> **GATE:** AGENTS.md exists as the authoritative routing doc.

## Step 8 — Tag and Clean Backups

After all seed commits are staged/committed:

1. **Tag the current commit** as `agent-seed/YYYY-MM-DD` (today's date). This preserves a reference to the old structure — the `.bak` files are recoverable via `git show agent-seed/YYYY-MM-DD:.agents/references/CLAUDE.md.bak`.
2. **Remove all `.md.bak` files** from `.agents/references/` (e.g. `CLAUDE.md.bak`, `AGENTS.md.bak`).
3. **Commit the removal** with message: `chore: remove seed backup files`

If the tag `agent-seed/YYYY-MM-DD` already exists (re-run on the same day), append a sequence suffix: `agent-seed/YYYY-MM-DD.2`, `.3`, etc.

> **GATE:** Tag exists. Backup files removed and committed.

## Step 9 — Report & Offer Cleanup

Print summary:
- Files created (list)
- Files updated (list)
- Files migrated (source -> destination)
- Placeholders needing manual fill-in
- Final CLAUDE.md line count
- Final AGENTS.md line count
- Git tag created (name)

Then ask the user:
> "School files are seeded. A later session can prune any file that passes its line cap. Start a fresh session so the next agent reads the slim layout?"

Always ask. The agent-seed run itself burns context, and a fresh session lets the next agent read the slim layout.
