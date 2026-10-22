---
name: erd
description: Generate architecture maps and arbitrary Mermaid diagrams as Markdown or standalone HTML.
allowed-tools: Bash(~/.dg/bin/dg-skills:*), Read, AskUserQuestion
---

# /dg:erd

Map a codebase and its reachable database schema, or render a described graph from structured JSON.

First run: install or refresh the CLI when it is missing or too old. Every later call uses the literal installed path:

```bash
~/.dg/bin/dg-skills erd --help >/dev/null 2>&1 ||
  curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.18.0/pkg/skills-cli/bootstrap.sh | sh -s -- --cli-only
```

If a step fails, run ~/.dg/bin/dg-skills doctor erd.

## Usage

**Usage:** `~/.dg/bin/dg-skills erd resolve <concept-or-path>` · `~/.dg/bin/dg-skills erd generate [scope] [--depth N] [--out <path>] [--type er|flow] [--html]` · `~/.dg/bin/dg-skills erd render --type <er|flow|sequence|state|class> --data <file|-> [--out <path>] [--html]`

## Flags

| Flag | Short | Effect | Default |
|---|---|---|---|
| `--depth N` | none | Cap directory descent for `generate`. | no depth cap; a 7,500-node safety cap applies |
| `--out <path>` | none | Set the artifact base path; `.md`, `.json`, and optional `.html` suffixes are added. | `.agents/architecture/<scope-slug>` or `.agents/architecture/render-<type>` |
| `--type <type>` | none | Narrow `generate` to `er` or `flow`, or select any supported `render` diagram. | combined architecture document for `generate`; required for `render` |
| `--data <file\|->` | none | Read structured render data from a JSON file or stdin. | required for `render` |
| `--html` | none | Also write and locally open a themed standalone HTML rendering. | off |
| `--help` | `-h` | Show command help without scanning or opening anything. | off |

## Architecture generation

Before a large scan, print `Scanning <scope>...` so the user sees progress.

```bash
~/.dg/bin/dg-skills erd resolve "<concept-or-path>"
~/.dg/bin/dg-skills erd generate <scope> [--depth N] [--out <path>] [--type er|flow] [--html]
```

`resolve` returns `{ candidates: ErdCandidate[] }`. For fuzzy input, present those candidates with `AskUserQuestion`, then generate the chosen candidate ID. A hard collection failure exits 1 and writes the error to stderr.

Without `--type`, `generate` writes the full architecture document: directory tree, module table, import flowchart, schema ER diagram when available, cross-links, and evidence. `--type flow` writes only the import diagram; `--type er` writes only the schema diagram. Report the `.md` path and the code-node, code-edge, DB-node, DB-edge, and evidence counts from the JSON result.

## Generic rendering

Use `render` when the requested sequence, state, class, flow, or schema graph comes from reading and describing the system rather than directory analysis:

```bash
~/.dg/bin/dg-skills erd render --type sequence --data flow.json
printf '%s' "$JSON" | ~/.dg/bin/dg-skills erd render --type state --data - --html
```

Create the smallest truthful JSON document. Never invent a participant, transition, relation, import, table, or column. See [render data shapes](references/render-data-shapes.md) for exact schemas.

The default artifact is Markdown with one or more fenced Mermaid blocks. `--html` adds one HTML file that loads the pinned Mermaid renderer from jsDelivr, follows the system light/dark theme, and opens through the platform-aware local opener.

## Database boundary

`erd` never reads database credentials. Live discovery re-enters the same installed `dg-skills` binary through `db connections` and `db schema <conn>`, then falls back to static schema sources.

## References

- [Markdown output](references/markdown-template.md)
- [Render data shapes](references/render-data-shapes.md)
- [Supported schema sources](references/supported-schema-sources.md)
