---
name: meaningful
description: Reshape the current branch's commits into meaningful, easy-to-review chunks. Delegates analysis to a subagent that proposes 3+ regrouping options, prompts the user to pick one, then soft-resets and recommits accordingly and force-pushes with lease.
---

# Skill: meaningful

Reshape commits on the current branch since `main` into a tighter, more reviewable sequence — squashing fixups, separating concerns, rewording stale messages — then republish.

## Runtime and skill paths

Resolve the compiled CLI before running any command:

```bash
DG="$HOME/.dg/bin/dg-skills"
if [ ! -x "$DG" ]; then
  LOCAL_BOOTSTRAP="${CLAUDE_PLUGIN_ROOT:-}/pkg/skills-cli/bootstrap.sh"
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "$LOCAL_BOOTSTRAP" ]; then
    sh "$LOCAL_BOOTSTRAP"
  else
    curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/master/pkg/skills-cli/bootstrap.sh | sh
  fi
fi
```

Repeat this resolution in every fresh shell, delegated execution and resumed
command; shell variables do not persist between tool calls. Honor the host's
existing narrow approvals for each operation and permissions already granted in
this session. Do not edit permission files or treat the compiled binary as a
blanket grant for all subcommands.

Resolve cross-skill instructions through the installed sibling tree
(`../<skill>/SKILL.md` here, `../../<skill>/SKILL.md` from `references/`). If a
skill is missing, use only an explicitly configured `DG_PERSONAL_SKILLS_DIR`.
Resolve the reviewer persona through the host registry or configured
`DG_PERSONAS_DIR` / `DG_AGENTS_DIR`; pass its real absolute path to delegates.
Report missing instructions without assuming a private checkout or cache path.
The plugin ships its personas in `agents/` (Claude Code loads them as
`dg:<name>`; `dg-skills proxy` embeds them), so use those when the host has none.

## Args
- *(none)*: full flow — gather, propose, pick, apply, force-push-lease.
- `--dry-run`: stop after presenting the chosen plan; do not reset, commit, or push.

## Preconditions
- Not on `main`/`master`.
- Working tree clean (no uncommitted edits, no staged changes).
- At least 2 commits ahead of base (1 commit → suggest `git commit --amend` and stop).

If any fail, print the reason and stop. Do not attempt to clean up the user's working tree.

## Flow

**1. Gather** — run `"$DG" meaningful info`. If `ahead < 2`, stop. Load [references/helper-api.md](references/helper-api.md) for the full JSON schema and field descriptions.

**2. Propose** — spawn a `reviewer` subagent using the host's configured persona to read per-commit diffs and return ≥3 distinct regrouping options. Load [references/proposal-format.md](references/proposal-format.md) for the exact subagent brief and `=== Option N ===` block format before briefing the subagent. Pass the full `info` JSON including `commits[].author` and `file_authors` so the subagent can assign authorship per group.

**3. Present** — use the host's user-question interface with each option as a choice: label = one-line option title, description = tradeoff sentence, preview = MSG subjects + file counts per group.

The user must select a concrete proposal before applying it. Explain that applying
the chosen plan rewrites this branch and pushes the resulting commits. Honor an
existing approval for that exact plan and operation; do not ask for it again.

**4. Apply** — load [references/helper-api.md](references/helper-api.md) for the plan file formats and path formulas. **Prefer the JSON plan** (`references/helper-api.md` §Plan File Format (JSON)) over the text format whenever any group has a body — the text parser cannot represent `subject\n\nbody` without gluing or dropping it, the JSON path can. Write the chosen plan to the temp file path (`.json` extension), including `author`/`coauthors` per group from the proposal. If `--dry-run`, print the plan path and stop. Otherwise run `"$DG" meaningful apply-json <plan-file>` (or `"$DG" meaningful apply <plan-file>` for a body-less text plan). Report the backup SHA to the user. Claude `Co-Authored-By` trailers are stripped automatically by the helper either way.

**5. On failure** — if the helper exits non-zero, report the backup SHA and recovery options. Details in [references/helper-api.md](references/helper-api.md) §Failure Recovery.

## Notes
- Never use plain `--force`; the helper uses `--force-with-lease`.
- Only commits on this branch (since merge base) are in scope — never reshape across the merge base.

## Validation

The ported real-git suite is `pkg/skills-cli/__tests__/meaningful.spec.ts`. It
preserves the ten legacy history/backup/rollback cases and checks CLI status,
plan schemas, literal paths/messages, attribution and inert imports in disposable
repositories with local bare remotes and isolated durable state.
