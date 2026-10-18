---
name: agent-seed
description: Bootstrap and normalize a project's .agents/ structure, slim CLAUDE.md to a minimal stub, create AGENTS.md as the primary authority with conventions and routing, and move reference material into .agents/references/ for on-demand consumption.
---

# Skill: agent-seed

Bootstrap the canonical `.agents/` structure for any project. CLAUDE.md becomes a minimal stub (commands + pointer). AGENTS.md becomes the primary authority carrying conventions and routing all deep context.

Before starting, read these reference files:

- [references/workflow.md](references/workflow.md) — 9-step ordered workflow with gate conditions
- [references/templates.md](references/templates.md) — CLAUDE.md, AGENTS.md, school stub, and reference file templates
- [references/classification.md](references/classification.md) — What stays in CLAUDE.md vs. AGENTS.md vs. .agents/references/

## What It Produces

```
CLAUDE.md                   <- minimal stub: 15-25 lines (name, commands, pointer to AGENTS.md)
AGENTS.md                   <- primary authority: 30-60 lines (conventions, references, specs, workflow)
.agents/
  paths.md                  <- repo file/directory lookup table (agents read before exploring)
  monolith.md               <- project vocabulary, if the repo already has one (not seeded here)
  references/               <- on-demand deep context
    architecture.md         <- system design, component map, data flow
    patterns.md             <- code conventions, idioms, examples
    directory-tree.md       <- annotated 3-level project tree
    domain.md               <- domain model, terminology, business rules
  school/                   <- topic-cluster learnings (any agent writes; prune when a file passes its own line cap)
  spec/                     <- spec bundles (/kick and /pickup write here)
```

A git tag `agent-seed/YYYY-MM-DD` is created on the commit containing the original `.bak` backups, then the `.bak` files are removed in a follow-up commit. To recover the original CLAUDE.md: `git show agent-seed/<date>:.agents/references/CLAUDE.md.bak`

## Rules

- **AGENTS.md is the authority.** CLAUDE.md just points to it.
- Always backup CLAUDE.md (and AGENTS.md if it exists) before rewriting. Halt if backup fails. Backups are committed then removed (see Step 10 — tag preserves recovery path).
- School files: seed stubs with inline format rules. Any agent may write entries following the format. Prune a school file when it passes the line cap in its header.
- Never create or touch `.agents/school/DEPS.md` — that belongs to deps-upgrade.
- For monorepos, create per-package `AGENTS.md` files (thin pointers to root).
- If non-canonical `.agents/` content exists, report it and list the files. Do not invoke a cleanup skill.
- Append (don't overwrite) to reference files that already have content.
