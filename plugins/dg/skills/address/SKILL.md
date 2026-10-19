---
name: address
description: Address PR review comments AND failing CI/CD checks — route fixes to agent(s), QA, document, commit, push, reply+resolve threads. (Use /catchup for merge conflicts and rebasing — not this skill.)
---

# Skill: Address

Fix PR review comments, CI/CD failures, and local code-review findings. Test-first for code changes, QA, commit, push, reply+resolve threads.

**Scope:** `/address` = review + CI + local. `/catchup` = merge conflicts and rebasing.

**Usage:** `/address [-l] [-a <agent>[,agent2,...]] [-m "<context>"] [--round N] [--verdicts <path>] [--no-ci]`

## Runtime and skill paths

Resolve the compiled CLI before running any command:

```bash
DG="${DG_HOME:-$HOME/.dg}/bin/dg-skills"
if [ ! -x "$DG" ]; then
  LOCAL_BOOTSTRAP="${CLAUDE_PLUGIN_ROOT:-}/pkg/skills-cli/bootstrap.sh"
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "$LOCAL_BOOTSTRAP" ]; then
    sh "$LOCAL_BOOTSTRAP"
  else
    curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.15.0/pkg/skills-cli/bootstrap.sh | sh
  fi
fi
```

Repeat this resolution in every fresh shell, including delegated execution and
resumed commands; shell variables do not persist between tool calls. Use the
host's existing narrow approvals for the specific operation and honor permission
already granted in this session. Do not edit permission files or assume that the
compiled binary grants blanket approval to its subcommands.

Resolve cross-skill instructions from this installed tree using sibling paths
(`../<skill>/SKILL.md` from this directory, `../../<skill>/SKILL.md` from
`references/`). If an unmigrated skill is missing, use only an explicitly
configured personal skill root (`DG_PERSONAL_SKILLS_DIR/<skill>/SKILL.md`). Pass
the resulting real absolute paths to delegates. Report missing instructions;
never assume a private checkout or cache location. Agent names below refer to
the host's configured personas; resolve their files through the host registry or
explicit `DG_PERSONAS_DIR` / `DG_AGENTS_DIR` configuration when needed.
The plugin ships its personas in `agents/` (Claude Code loads them as
`dg:<name>`; `dg-skills proxy` embeds them), so use those when the host has none.

## Phases

- Phase 0: parse args
- Phase 0.25: worktree merge-detection + cleanup
- Phase 0.5: permissions probe
- Phase 1: gather: local code-review file (resolved to PR's worktree dir, always) + PR threads + CI checks + Wiz findings (via the Wiz MCP, when a Wiz bot comment or `Wiz *` check exists)
- Phase 1.45: apply `#explain` threads (reply + resolve, no fix)
- Phase 1.5: antagonist triage (skip if `--verdicts` supplied)
- Phase 1.6: apply rejections
- Phase 1b: auto-detect agents
- Phase 2: fix: CI first, then comments (test-first → apply)
- Phase 3: QA (max 3 cycles)
- Phase 4: document
- Phase 5: commit + push
- Phase 6: reply + resolve (PR/MR comment items only — GitHub or GitLab, CI and local skip this)
- Phase 7: local review cleanup — delete each local code-review file once all its findings are accomplished (fixed+committed or rejected); keep files with blocked/skipped findings

**Review reply invariant:** reply inline to the gathered review comment, then resolve that same thread. Never use a
top-level PR/MR comment as the response. A reply must be confirmed published before resolution; if replying fails,
leave the thread open.

## Comment Flags

| Flag | Effect |
|------|--------|
| `#ignore` | Drop entirely — no reply, no resolve. |
| `#explain` | Reply with explanation, resolve. No code change. `#ignore` wins if both set. |

## Flags

| Flag | Description |
|------|-------------|
| `-l, --local` | Address only the latest `.agents/code-review/YYYY-MM-DD-HHMMSS-NNN.md`. Skip PR/MR threads and CI. |
| `-a` | Comma-separated agent list. Omit → auto-pick. |
| `-m` | Extra context passed to fix agents. |
| `--round N` | Tag commit `(review-loop round N)`. |
| `--verdicts <path>` | Pre-filtered verdict JSON (skip triage). Pauses on `strange` items. |
| `--no-ci` | Skip CI gathering. |

Bare args treated as agent list. All replies prefixed `🤖 ` by `"$DG" address` — never construct it yourself.
Set `ADDRESS_BOT_PREFIX="[bot] "` on a host that mangles emoji. Both markers, plus the legacy `[bot] ` on
replies already posted, count as bot replies on read.

## References (load on demand)

- [references/workflow.md](references/workflow.md) — phases, I/O, gates
- [references/agents.md](references/agents.md) — roster + file-extension routing
- [references/github-api.md](references/github-api.md) — human reference; runtime uses `"$DG" address`
