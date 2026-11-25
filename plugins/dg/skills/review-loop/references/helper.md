# Helper and runtime paths

## Runtime paths

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
`dg:<name>`; `dg proxy` embeds them), so use those when the host has none.

## Helper

Provider capability checks go through
`dg vcs-provider capabilities`. Use the compiled entrypoint with the
host's existing narrow approvals and session authorization.

Review-thread and bot-review operations go through
`dg address` (the same compiled command `/dg:address` uses), subject to
the same host approvals.
`dg address` is no longer GitHub-only — its review-thread,
bot-review and CI-failure subcommands work against GitLab too — but the
seven Copilot-bot subcommands this skill calls on it below are gated on
Copilot specifically, not on merely having some reviewer: six refuse
outright on GitLab (`EXIT.UNSUPPORTED`), and `check-copilot` alone still
answers with its existing `{available: false, reason}` JSON rather than
refusing. Subcommands used by
this skill: `check-copilot`, `check-bot-review`, `request-copilot`,
`verify-copilot-engaged`, `await-copilot-review`, `check-no-findings`,
`fetch-copilot-review`, `count-copilot-reviews`, `resolve-silent`,
`resolve-with-reply`. Bot-prefix on replies is enforced inside the
helper — callers never construct `🤖 ...` themselves.

`check-no-findings` is the single owner of the graphql scan for
`copilot-swe-agent` no-findings ack comments. It reads
`REVIEW_LOOP_NO_FINDINGS_PATTERN` (jq Oniguruma) for the match pattern.

Default mode never reaches the Copilot-bot subcommands on GitLab —
Phase 1's `capabilities` check routes to the bot-review flow, or to
proxy mode when no reviewer is configured, first (see
[references/workflow.md](references/workflow.md) Phase 1 and 1b).
**The
proxy-mode steps of this skill never call `dg address`** — round counting and diff-base
resolution there are plain `git`
(see [references/proxy-workflow.md](references/proxy-workflow.md)). The hand-off to `/dg:address -l` runs its own helper calls.
