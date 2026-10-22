# Reference Material Classification

When scanning CLAUDE.md (and existing AGENTS.md), classify each content block and route it.

## What Stays in CLAUDE.md

Only `@AGENTS.md`. Move everything else out: commands to `mise.toml` or the build scripts, and all other content by
the tables below.

## What Goes in docs/ (people)

| Content | Destination |
|---------|-------------|
| Branch, commit, PR, merge, and release rules | `docs/CONTRIBUTING.md` |
| Code style, lint and format tools, naming, per-language rules | `docs/code_standards.md` |
| Review tiers, comment format, verdict | `docs/code_review.md` |
| Why an architectural choice was made | `docs/adr/NNNN-<slug>.md` |

## What Goes in AGENTS.md (agents, always loaded)

| Content | Rule |
|---------|------|
| Project summary | One line |
| Packages table | Monorepos only |
| Rules | Traps only, one terse line each. Link the docs/ files for style. Never repeat `docs/code_standards.md` |
| References routing table | Always present; lists only files that exist |
| Specs & Learnings pointers | Always present |

Root AGENTS.md stays near 2.4K characters. Each package AGENTS.md stays under about 3.5K: stack, commands, short task
templates, traps, and a "References (read on demand)" table.

## What Goes in .agents/decisions/

Agent rules that follow from an ADR. Each file links its ADR in `docs/adr/` and does not repeat the ADR.

## What Moves to .agents/references/

| Content Type | How to Detect | Destination |
|-------------|---------------|-------------|
| Directory tree | Fenced code block or indented list with `/`, file extensions, or `├──` | `directory-tree.md` |
| Architecture description | Paragraphs about "system design", "data flow", "component", "service", "layer", "pipeline" | `architecture.md` |
| Code examples (>1 line) | Fenced code blocks with language tags | `patterns.md` |
| Pattern explanations | Paragraphs explaining "how to", "pattern", naming strategy with code refs | `patterns.md` |
| Domain terminology | Paragraphs defining business terms, models, entity relationships | `domain.md` |
| API documentation | Endpoint lists, request/response schemas, auth flows | `architecture.md` |
| Database schemas | Table definitions, migration notes, query patterns | `architecture.md` |
| Environment setup (detailed) | Multi-line env var docs, credential setup instructions | `architecture.md` |
| Import patterns | Import examples, entry point patterns | `patterns.md` |
| Feature detail for one package | Route lists, env var tables, job lists, entry points | `<pkg>-<topic>.md` |

## Edge Cases

- **Multi-line conventions**: A style rule goes to `docs/code_standards.md`. A trap keeps one line in AGENTS.md Rules, and its code example goes to `patterns.md`.
- **Mixed blocks**: Split — keep summary in AGENTS.md, move details to references.
- **Testing documentation**: Test commands live in `mise.toml`. Detailed patterns/fixtures/categories -> `patterns.md`.
- **Existing AGENTS.md content**: If it has custom agent workflow text, preserve it. Only update managed sections (inside `<!-- agent-seed:start/end -->` markers).
