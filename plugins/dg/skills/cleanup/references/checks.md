# Cleanup Check Patterns

<!-- Seed content: ships as part of the skill. -->

<!-- Self-upgrading accumulator, but only from a source checkout — see the skill's -->
<!-- "Source checkout vs. installed" section. An installed plugin proposes new -->
<!-- entries instead of writing them here. -->

<!-- At step 7, compare actions taken during steps 2-6 against this list. -->

<!-- For each action, construct a check-type: description pair. -->

<!-- If no existing entry matches (same check-type + similar description), append with today's date. -->

<!-- If >60 pattern lines, prune oldest entries from the top. -->

<!-- Recurring patterns that get re-discovered survive; one-offs eventually age out. -->

- [2026-03-17] orphan-dir: Empty agent-memory dirs should be deleted
- [2026-03-17] orphan-dir: agent-memory dirs not matching any roster or non-roster agent
- [2026-03-17] stale-artifact: SPEC.md in skill dirs (old format, replaced by SKILL.md)
- [2026-03-17] duplicate-entry: Agent listed in multiple sections of agents.md
- [2026-03-17] broken-link: SKILL.md reference table links pointing to nonexistent files
- [2026-03-17] missing-skill-md: Skill dir exists but has no SKILL.md
- [2026-03-17] empty-memory: agent-memory dir with 0-byte MEMORY.md
- [2026-03-17] stale-backup: .bak files in skill reference dirs
- [2026-03-17] memory-migrate: After agent merge, source memory should be appended to target
- [2026-04-01] post-migrate-skeleton: Empty MEMORY.md skeletons left after migration should be deleted (dir too)
- [2026-04-01] telemetry-prune: Failed telemetry events in ~/.claude/telemetry/ accumulate unbounded — purge all
- [2026-04-01] debug-rotation: Uncompressed debug dumps in ~/.claude/debug/ — delete files older than 7 days
- [2026-04-01] orphan-todos: Empty 2-byte JSON stubs in ~/.claude/todos/ — purge all
- [2026-04-17] broken-symlink: Dangling symlinks in ~/.claude/debug/ (e.g. `latest` pointing to purged dump) — remove
- [2026-04-17] empty-active-agent-dir: Roster-valid agent-memory dir with no MEMORY.md and no files — delete (will be recreated on next write)
- [2026-04-27] non-roster-real-agent: Sub-agent used by a skill but absent from the address roster (e.g. copilot-antagonist via review-loop) — add to whitelist before deleting empty dir
- [2026-04-30] roster-declares-missing-agent: Roster lists an agent that has no agent-memory dir AND no agents/<name>*.md file — flag to user; cleanup never edits the roster directly
- [2026-04-30] false-positive-link: Naive `references/...` regex strips relative path prefixes (`../skill/`, `address/`) — must verify actual file existence before flagging broken
- [2026-05-28] stash-walker: entries under a stash root's `<tool>/` past that root's TTL are stale; never touch the skip list in targets.md
- [2026-10-08] three-stash-roots: scratch (`~/.dg/bin/dg-skills stash -r`, 14 days), state (`~/.dg/bin/dg-skills stash -r -s`, 30 days), agents (`~/.dg/bin/dg-skills stash -r -a`, 30 days, git-ignored files only). Resolve roots with `~/.dg/bin/dg-skills stash -r`, never hardcode
- [2026-10-08] global-scope-entries: `~/.dg/bin/dg-skills stash -G` tools write with no bucket; the walker prunes those files and dirs by newest mtime in both roots
- [2026-10-08] agents-root-safety: delete only git-ignored `.agents` files; never tracked, untracked-not-ignored, or `.git/` content
- [2026-06-29] stale-pycache: __pycache__ inside skill dirs should be deleted
- [2026-06-29] stale-agent-ref: retired agent slugs in skill references should be rewritten to canonical roster targets
- [2026-07-09] migrated-flat-scratch: bulk flat files relocated into a retired scratch root get fresh mtime + match no walker/legacy pattern — surface for opt-in sweep, never auto-delete a user's flat scratch
- [2026-07-20] project-memory-orphan: empty per-project memory dirs at ~/.claude/projects/*/memory/ (e.g. left after a full memory clear) — delete; recreated on next write
