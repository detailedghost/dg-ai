# Reference Material Classification

When scanning CLAUDE.md (and existing AGENTS.md), classify each content block and route it.

## What Stays in CLAUDE.md

| Content | Rule |
|---------|------|
| Project name (H1) | Always keep |
| 1-2 sentence description | Keep if concise; rewrite if verbose |
| Build/test/lint/dev commands | Keep in Commands table |
| Pointer to AGENTS.md | Always add as final line |

**Nothing else stays in CLAUDE.md.** Conventions, architecture, patterns, domain — all move to AGENTS.md or `.agents/references/`.

## What Goes in AGENTS.md

| Content | Rule |
|---------|------|
| Project summary | 1-2 sentences (may reuse CLAUDE.md description) |
| Conventions | Up to 10, one line each, specific and actionable |
| Packages table | Monorepos only |
| References routing table | Always present |
| Specs & Learnings pointers | Always present |
| Agent Workflow section | Always present |

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

## Edge Cases

- **Multi-line conventions**: Extract code example to `patterns.md`, leave a one-line summary in AGENTS.md conventions.
- **Mixed blocks**: Split — keep summary in AGENTS.md, move details to references.
- **Testing documentation**: Short test commands stay in CLAUDE.md commands table. Detailed patterns/fixtures/categories -> `patterns.md`.
- **Existing AGENTS.md content**: If it has custom agent workflow text, preserve it. Only update managed sections (inside `<!-- agent-seed:start/end -->` markers).
