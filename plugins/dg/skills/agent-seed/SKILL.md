---
name: agent-seed
description: Bootstrap and normalize a project's .agents/ structure and human docs. CLAUDE.md becomes @AGENTS.md, AGENTS.md stays token-lean (traps and routing), style rules move to docs/code_standards.md, review rules to docs/code_review.md, and feature detail to .agents/references/ for on-demand reads.
---

# Skill: agent-seed

Bootstrap the canonical `.agents/` structure and the human docs for any project. People read `docs/`. Agents read a token-lean `AGENTS.md` that holds traps and routes to everything else. CLAUDE.md is the single line `@AGENTS.md`.

Before starting, read these reference files:

- [references/workflow.md](references/workflow.md) — 9-step ordered workflow with gate conditions
- [references/templates.md](references/templates.md) — CLAUDE.md, AGENTS.md, school stub, and reference file templates
- [references/classification.md](references/classification.md) — What goes in docs/ vs. AGENTS.md vs. .agents/references/ vs. .agents/decisions/
- [references/docs.md](references/docs.md) — docs/CONTRIBUTING.md, code_standards.md, code_review.md, copilot-instructions, and decision templates

## What It Produces

```
CLAUDE.md                   <- one line: @AGENTS.md
AGENTS.md                   <- about 2.4K characters: packages, traps-only rules, references, specs
<pkg>/AGENTS.md             <- monorepos, under about 3.5K each: stack, commands, task templates, traps, references
docs/
  CONTRIBUTING.md           <- how a change gets in (people)
  code_standards.md         <- tools, naming, per-language rules (people)
  code_review.md            <- review tiers, format, verdict; copies /dg:thrash --spice 5 (people)
  adr/                      <- architecture decision records (people)
.github/copilot-instructions.md  <- under 4,000 characters; points to docs/code_review.md
.agents/
  decisions/                <- agent rules that follow from an ADR; each links its ADR
  paths.md                  <- repo file/directory lookup table (agents read before exploring)
  monolith.md               <- project vocabulary, if the repo already has one (not seeded here)
  references/               <- on-demand deep context
    architecture.md         <- system design, component map, data flow
    patterns.md             <- code conventions, idioms, examples
    directory-tree.md       <- annotated 3-level project tree
    domain.md               <- domain model, terminology, business rules
    <pkg>-<topic>.md        <- one feature area of one package (routes, env vars, jobs)
  school/                   <- topic-cluster learnings (any agent writes; prune when a file passes its own line cap)
  spec/                     <- spec bundles (/dg:kick and /dg:pickup write here)
```

A git tag `agent-seed/YYYY-MM-DD` is created on a commit that force-adds the original `.bak` backups, then the `.bak` files are removed in a follow-up commit. To recover the original CLAUDE.md: `git show agent-seed/<date>:.agents/references/CLAUDE.md.bak`

## Rules

- **AGENTS.md routes, docs/ rules.** CLAUDE.md is `@AGENTS.md`. AGENTS.md holds traps and links. Style and review rules live once, in `docs/`.
- Before you move text out of CLAUDE.md, AGENTS.md, or a doc, find the repo tests that read it, and keep their coverage.
- Never leave an empty file or an empty folder under `.agents/`.
- Always backup CLAUDE.md (and AGENTS.md if it exists) before rewriting. Halt if backup fails. Backups are committed then removed (see Step 8 — tag preserves recovery path).
- School files: seed stubs with inline format rules. Any agent may write entries following the format. Prune a school file when it passes the line cap in its header.
- Never create or touch `.agents/school/DEPS.md` — that belongs to deps-upgrade.
- For monorepos, create per-package `AGENTS.md` files from the template in templates.md.
- If non-canonical `.agents/` content exists, report it and list the files. Do not invoke a cleanup skill.
- Append (don't overwrite) to reference files that already have content.
