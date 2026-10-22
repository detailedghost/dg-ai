---
name: monolith
description: Scan the codebase and consolidate its native vocabulary (domain terms, naming conventions, architectural patterns, ambiguities) into `.agents/monolith.md`. Append-only on re-run; splits into `.agents/monolith/<domain>.md` once the file touches its byte cap; supports --shallow/-s (single-Explore scan), --prune (drop entries whose source files no longer exist) and --split (force the domain split). Use when the user wants agents and humans speaking the project's dialect.
disable-model-invocation: true
---

# Skill: monolith

Extract a project's native vocabulary and write it to `.agents/monolith.md` so every agent (and human) speaks the same language. Lean by design: ~6 KB per file, table format, append-only. Once the vocabulary outgrows 6 KB it splits into `.agents/monolith/<domain>.md`, one file per domain, and `monolith.md` becomes the index — so an agent loads the domain it is working in, not the whole glossary.

First run: install or refresh the CLI when it is missing or too old. Every later call uses the literal path, so each Bash call works alone:

```bash
~/.dg/bin/dg-skills monolith --help >/dev/null 2>&1 ||
  curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.18.0/pkg/skills-cli/bootstrap.sh | sh -s -- --cli-only
```

If a step fails, run ~/.dg/bin/dg-skills doctor monolith stash.

Before starting, read these reference files:

- [references/protocol.md](references/protocol.md) — phase-by-phase orchestration, agent prompts, conflict handling
- [references/template.md](references/template.md) — exact `monolith.md` skeleton + section rules

Helper CLI: `~/.dg/bin/dg-skills monolith <subcommand>` (subcommands documented via `--help`). The scan workflow and template ship in this skill's `references/` and are resolved from the installed skill, never from user-local files.

## Invocation

**Usage:** `/dg:monolith [--shallow | -s] [--prune] [--split]`

```
/dg:monolith [--shallow | -s] [--prune] [--split]
```

- **default:** 3 parallel `Explore` agents → 1 `dg:lore` writer → `.agents/monolith.md`. Patches AGENTS.md (preferred) or CLAUDE.md (fallback) with a vocabulary pointer.
- **`--shallow` / `-s`:** uncommitted single-agent scan under `$(~/.dg/bin/dg-skills stash -s monolith)`, no `.agents/` prerequisite, no AGENTS.md/CLAUDE.md retrofit, no git commit — exact path formula and the shallow↔full promote/demote commands are in `references/protocol.md` Phase 0 (mandatory read anyway, see above).
- **`--prune`:** delegate to `~/.dg/bin/dg-skills monolith prune`; remove rows whose `_src:_` paths no longer exist; then exit. Honors `--shallow` for path selection.
- **`--split`:** delegate to `~/.dg/bin/dg-skills monolith split`; partition the file into `.agents/monolith/<domain>.md` and leave an index; then exit. Runs on demand even when the file is under cap. Honors `--shallow` for path selection.

## Flags

| Flag | Short | Effect | Default |
|---|---|---|---|
| `--shallow` | `-s` | Uncommitted single-agent scan under the stash path. No `.agents/` prerequisite and no commit. | off |
| `--prune` | none | Remove rows whose `_src:_` paths no longer exist, then exit. | off |
| `--split` | none | Partition the file into `.agents/monolith/<domain>.md` with an index, then exit. | off |

## Phases

1. **Bootstrap** — `~/.dg/bin/dg-skills monolith bootstrap .` to create `.agents/` if missing and detect APPEND_MODE.
2. **Existing terms** — if APPEND_MODE=1, run `~/.dg/bin/dg-skills monolith list-terms` to capture known terms (passed to scanners as a "focus on what's missing" hint).
3. **Scan + Consolidate** — one background **Workflow** (`references/scan.workflow.mjs`): scanners (haiku, parallel — 3 in default, 1 in `--shallow`) → `dg:lore` synthesis. `dg:lore` is the only writer (both modes — never the main agent) and writes to a staging path `.agents/monolith.md.new`. See `references/protocol.md` Phase 2-3 for the args.
4. **Resolve conflicts** — `~/.dg/bin/dg-skills monolith detect-conflicts` against the staging file. Interactive: `AskUserQuestion` per conflict. Non-interactive (or `MONOLITH_NONINTERACTIVE=1`): `apply-conflict-resolution` keeps existing rows and logs candidates to `.agents/school/monolith-conflicts.md`. Then promote staging → live. (Interactive — stays in the orchestrator, outside the workflow.)
5. **Post-process** — `~/.dg/bin/dg-skills monolith validate` → `cap-report` → `split` when over cap → `patch-agents-md .agents/AGENTS.md`.
6. **Report** — print a one-paragraph summary: terms added, conflicts resolved (and how), ambiguities flagged, relationships emitted, and the domain files written if the file was split.

## Rules

- **Helper does the deterministic parts.** Parsing, validation, prune, splitting, conflict detection/resolution, pointer patching — never do these in-conversation.
- **Over the cap means split, not trim.** A vocabulary that outgrows 6 KB has earned more room, so partition it by domain rather than deleting rows to fit. `split` derives the domain from each row's `_src:_` path, folds any domain under 3 rows into `general`, and refuses when every row lands in one domain — nothing is gained by splitting a single-domain file.
- **`dg:lore` does synthesis in both full and `--shallow` modes.** Main agent never writes term tables itself. Lore writes to staging, never to the live file directly.
- **Append-by-default.** `dg:lore` is told existing rows are canonical (hand edits and prior generations are equally trusted) and may be updated only when the scan reveals materially better info. Conflicts surface as user-visible decisions, not silent overwrites.
- **Skill is explicit-only.** `disable-model-invocation: true` — never auto-fired.
- **Self-contained sub-agent prompts.** Sub-agents read every file you reference. NEVER reference the installed monolith skill directory or its files inside a `dg:lore`/scanner prompt — they will read SKILL.md, see `disable-model-invocation: true`, and refuse. Inline rules and template content directly.

## Routing

| Task | Read |
|---|---|
| Tuning a scan run — worktree checkouts, language-specialist scanner routing, model tiering, TSV format, file-search hierarchy for scanner prompts | `references/performance.md` |
