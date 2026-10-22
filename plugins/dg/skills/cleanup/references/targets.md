# Cleanup Targets

## Directories to Scan

### `~/.claude/agent-memory/`

Each subdirectory must:

- Match a roster agent name OR appear in the non-roster whitelist below
- Contain a `MEMORY.md` file
- Not be empty (no files at all)

### The skill tree

From a source checkout this is `plugins/dg/skills/`; from an installed plugin it is the
installed root (e.g. `~/.claude/plugins/cache/*/dg/*/plugins/dg/skills/`) — see the
skill's "Source checkout vs. installed" section.

Each subdirectory must:

- Contain a `SKILL.md` file
- Only contain `SKILL.md` and a `references/` subdirectory (nothing else at top level)

## Known Stale Artifacts (delete silently)

These files/dirs should never appear inside skill directories:

- `SPEC.md` — old format, replaced by SKILL.md
- `*.bak` — leftover backups
- `TODO.md` — ephemeral, should not persist in skills
- `__pycache__/` — Python cache leak
- `node_modules/` — dependency leak

## Cross-Reference Checks

### `../address/references/agents.md` (roster)

- No agent name should appear in multiple sections (Selectable table, QA Agents bullets, Support Agents bullets)
- Strip the `dg:` prefix from each name before comparing; the remainder must be a lowercase-hyphen slug (match `^[a-z][a-z0-9-]*$`)

### Each `SKILL.md`

- Relative links in the reference table (lines matching `[references/...](references/...)`) must resolve to existing files

### Each `agent-memory/*/MEMORY.md`

- Warn if file is 0 bytes (empty memory)

## Roster Parsing

Parse three sections from `../address/references/agents.md`:

1. **Selectable table** — column 1 of the markdown table under "Selectable (Phase 2c)"
1. **QA bullets** — names after `- \`` under "QA Agents (Phase 3, always)"
1. **Support bullets** — names after `- \`` under "Support Agents"

Strip surrounding backticks and any leading `dg:` from all parsed names.

## Ephemeral Directories (purge stale contents)

### `~/.claude/telemetry/`

- Delete all `1p_failed_events.*.json` files (failed events, never retried)

### `~/.claude/debug/`

- Delete `.txt` files older than 7 days (`find -mtime +7`)

### `~/.claude/todos/`

- Delete all `.json` files that are 2 bytes or less (orphan stubs)

### AI stash pruning (TTL walkers)

**Three stash roots.** Every skill that writes working files gets its path from
`~/.dg/bin/dg-skills stash <tool> [name]`. Never build these paths by hand and never
hardcode the defaults.

| Root | Flag | Resolve with | TTL | Holds |
|---|---|---|---|---|
| scratch | (none) | `~/.dg/bin/dg-skills stash -r` | **14 days** | throwaway work; reboot-wiped by design |
| state | `-s` | `~/.dg/bin/dg-skills stash -r -s` | **30 days** | run state a reboot must not destroy |
| agents | `-a` / `-m` | `~/.dg/bin/dg-skills stash -r -a` / `~/.dg/bin/dg-skills stash -r -m` | **30 days** | git-ignored files in each worktree's `.agents/<tool>/` |

Scratch and state are laid out `<root>/<tool>/<bucket>/<name>`. Global tools
(`~/.dg/bin/dg-skills stash -G`) write `<root>/<tool>/<name>` with no bucket.

**Automated.** `$DG_DAILY_PRUNE_CMD` implements the walks below; the skill's "Scan AI stash roots" step runs it and stops with an actionable error when the variable is unset or does not resolve to an executable. It runs daily from the host's own session-start hook independent of this skill; `--now` forces a run and `--dry-run` reports only. Keep it and these rules in sync.

**Walk (scratch and state).** For each entry directly under `<root>/<tool>/` (bucket dir,
global file, or global dir): if its newest mtime, including descendants, is older than
that root's TTL, delete it. If the tool dir was emptied, remove it too. Flat files
directly under the scratch root follow the same 14 day rule.

**Walk (agents root).** For every worktree (main, linked, detached) of every tracked
repo: list the git-ignored files under `.agents` and delete only the ones older than 30
days. Then remove emptied dirs that are git-ignored. Never delete tracked files,
untracked files that are not ignored, or anything under `.git/`. Also never delete, even
when ignored and old: `.agents/school/**`, `.agents/references/**`, `.agents/spec/**`,
`.agents/decisions/**`, `.agents/monolith.md`, `.agents/monolith/**`, `.agents/jot/**`,
`.agents/paths.md`, and any `HANDOFF.md` under `.agents/`.

**Do not touch (skip list):**

- `hooks/` and `adhoc/` tool dirs. Hook markers are keyed by the session id, not by cwd.
  `adhoc/<bucket>/` holds the user's own parked files: surface for opt-in sweep, never
  auto-delete.
- `subagent-statusline-samples.jsonl`, `subagents-current.json`, and
  `hook-comment-disabled.*` at the scratch root. Live statusline and hook state.
- `bg/*.pid` live pid files.
- `skill-cleanup/backups/`. Surface the total size in the report and let the user decide.
- `pw/states`, `pw/sessions`, `pw/sockets`, `test-live/state`, and `ghattach-chromium/`.
  Saved logins and live sockets.

**Legacy migration (one-time).** Also delete files matching the **old** flat patterns
regardless of mtime, since current code never touches them:

- `<scratch>/{create-spec,roundtable,snap-discovery,refactor,review-loop,deps,meaningful-plan,monolith-scan-output}-*`
- an old `prototype/` subdirectory left under `<scratch>/<8-hex dir>/` (superseded by `/dg:proto`)
- `<scratch>/monolith/<slug>/` where `<slug>` is not an 8-hex bucket

Log what was removed in the run report.

## Non-Roster Agent Whitelist

<!-- Self-upgrade target: if user says to keep an unknown dir, add it here -->

- `dg:foreman` — used by `/dg:spec`, `/dg:sdlc` slice derivation, and ad hoc plan drafts
- `dg:shell` — user-scoped general agent
- `dg:copilot-antagonist` — used by `/dg:review-loop`
- `dg:arch` — architecture sounding-board agent; ad-hoc invocation, not part of the address roster
- `dg:design` — UX/UI critique agent; gated on frontend scope in `/dg:spec`
- `dg:checkpoint` — mechanical checkbox auditor agent; used by wave/foreman flows, not part of the address roster
- `dg:qa-code` — active QA agent (static analysis, test coverage, style/logic review); not part of the address roster's QA Agents list
