---
name: review-loop
description: >-
  Antagonistic review loop for a branch. Default mode drives GitHub
  Copilot review on an open PR, filters its comments through a
  copilot-antagonist agent, hands accepted items to /dg:address, and
  repeats. `--proxy <backend>` mode swaps the reviewer for a local
  proxy-backend coding agent (codex/copilot/pi/opencode/grok) instead —
  no PR or GitHub Copilot access required, findings flow straight
  into /dg:address's local code-review path. Both modes are
  fire-and-forget and capped at a few rounds by default.
---

<!-- markdownlint-disable MD003 MD013 MD022 MD033 MD041 MD060 -->

# /dg:review-loop — Antagonistic Review Loop

Two review sources, one round shape: request a review (GitHub Copilot,
or a local `/dg:proxy` backend), filter the findings, hand survivors to
`/dg:address`, repeat.

**Default mode** runs on the branch of an open PR. The skill is
**stateless and fire-and-forget**: each invocation does one step of the
round. Re-invoke after Copilot posts a new review (or let auto mode
drive all rounds in one go).

On a provider whose AI reviewer is not Copilot — GitLab with an explicitly
configured reviewer — default mode runs the **bot-review flow** instead: it waits for
the reviewer's own merge-request comments and hands them to `/dg:address`,
which already reads GitLab threads. It does not trigger the reviewer
and does not route to proxy mode. See
[references/workflow.md](references/workflow.md) Phase 1b.

Only a provider that reports **no** AI review bot at all auto-routes to
[Proxy mode](#proxy-mode) below — no `--proxy` flag needed. The backend
comes from the required `REVIEW_LOOP_DEFAULT_PROXY_BACKEND` environment
variable. Findings from an auto-routed run are LOCAL-ONLY, the same as
any other proxy run: they surface through `/dg:address` and are never
posted back to the merge request. See
[references/workflow.md](references/workflow.md) Phase 1 for the gate.

`capabilities` names the reviewer in `aiReviewBotNames`. On GitLab that
comes from explicit `AI_VCS_GITLAB_REVIEW_BOT` configuration (comma-separated).
With that variable unset, empty, or `none`, GitLab reports no reviewer and
uses the proxy route.

**Proxy mode** (`--proxy <backend>`) needs no PR and no GitHub Copilot
access — it reviews the current branch's diff with a local external
coding agent instead. See [Proxy mode](#proxy-mode) below.

**Usage:** `/dg:review-loop [-r N] [-w <sec>] [-s] [-n] [-k]`
**Usage (proxy):** `/dg:review-loop -p <codex|copilot|pi|opencode|grok> [-b <ref>] [-r N] [-s] [-k]`

## Flags

| Flag | Short | Effect | Default |
|---|---|---|---|
| `--rounds N` | `-r` | Override the round cap. Also settable via `REVIEW_LOOP_MAX_ROUNDS`. | `2` |
| `--wait-timeout <sec>` | `-w` | Cap for each between-round wait. On timeout the skill exits cleanly so you can re-run later. Applies to default mode and the GitLab bot-review flow. Proxy mode has no polling wait and ignores it. | `1800` |
| `--single` | `-s` | Run one round step and exit. Use for manual pacing between rounds. | off |
| `--no-retrigger` | `-n` | Run one round and skip the re-request at the end. Implies `--single`. In proxy mode it is a no-op alias for `--single`. | off |
| `--skip` | `-k` | No-op exit. Use when a planning workflow auto-invokes this and you want to bail out. | off |
| `--proxy <backend>` | `-p` | Switch to proxy mode. `<backend>` is one of `codex`, `copilot`, `pi`, `opencode`, `grok`, passed straight through to `/dg:proxy`. No PR required. | off (Copilot review) |
| `--base <ref>` | `-b` | Proxy mode only. Override diff-base detection. | detected base |

### Default: auto mode

`/dg:review-loop` drives every round in one invocation by default:
trigger → verify Copilot engaged → wait for review → antagonist →
`/dg:address` → re-trigger → verify → wait → …, up to `--rounds N`
(default 2). Between rounds the skill polls GitHub directly via
`~/.dg/bin/dg-skills address await-copilot-review` — its internal provider polling uses
no LLM tokens while waiting.

If Copilot doesn't engage within 5 min of a trigger, the skill escalates:
re-post a perturbed comment, then fall back to the `requested_reviewers`
API, then fail loud with a diagnostic.

Use `--single` for manual round-by-round control, or set
`REVIEW_LOOP_MAX_ROUNDS=1` to cap at one round globally.

### Proxy mode

`--proxy <backend>` replaces the GitHub Copilot reviewer with a local
`/dg:proxy` backend (codex/copilot/pi/opencode/grok) reviewing `base..HEAD` on
the current branch — no PR, no `gh`, no GitHub Copilot access needed.

Round shape: diff → `/dg:proxy <backend>` reviews it and writes findings
to a `.agents/code-review/*.md` file → `/dg:address -l --round N` (its
existing local-review triage/fix/QA/commit path, unchanged) → next
round, up to `--rounds N` (default 2). A round where the backend finds
nothing closes the loop immediately (dry-round close-out) instead of
burning further rounds.

No GitHub polling exists in this mode, so `--wait-timeout` is ignored
and there's no separate "re-trigger" step — `--no-retrigger` behaves
like `--single`.

See [references/proxy-workflow.md](references/proxy-workflow.md) for
the full phase breakdown.

## Reference Files (lazy-load)

| File | When to read |
|------|-------------|
| [references/workflow.md](references/workflow.md) | Default (GitHub) mode — always, when `--proxy` is absent. Phase-by-phase IN/OUT and gates. |
| [references/antagonist-prompt.md](references/antagonist-prompt.md) | Default mode only — when launching the `dg:copilot-antagonist` agent in the Act phase. |
| [references/proxy-workflow.md](references/proxy-workflow.md) | Proxy mode — always, when `--proxy` is present, or when default mode auto-routes here (no AI review bot on this provider). Phase-by-phase IN/OUT and gates. |
| [references/proxy-review-prompt.md](references/proxy-review-prompt.md) | Proxy mode only — when invoking `/dg:proxy` for a review round. |

## Runtime and skill paths

Resolve the compiled CLI before running any command:

```bash
~/.dg/bin/dg-skills address --help >/dev/null 2>&1 &&
  ~/.dg/bin/dg-skills bg --help >/dev/null 2>&1 ||
  curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.18.0/pkg/skills-cli/bootstrap.sh | sh -s -- --cli-only
```

If a step fails, run ~/.dg/bin/dg-skills doctor address bg proxy stash vcs-provider.

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

## Helper

Provider capability checks go through
`~/.dg/bin/dg-skills vcs-provider capabilities`. Use the compiled entrypoint with the
host's existing narrow approvals and session authorization.

Review-thread and bot-review operations go through
`~/.dg/bin/dg-skills address` (the same compiled command `/dg:address` uses), subject to
the same host approvals.
`~/.dg/bin/dg-skills address` is no longer GitHub-only — its review-thread,
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
proxy-mode steps of this skill never call `~/.dg/bin/dg-skills address`** — round counting and diff-base
resolution there are plain `git`
(see [references/proxy-workflow.md](references/proxy-workflow.md)). The hand-off to `/dg:address -l` runs its own helper calls.

## General Rules

- **Never** modify tracked files directly. All edits happen inside `/dg:address`.
- **Stateless.** Default mode: round number = current count of Copilot
  reviews on the PR. Proxy mode: round number = count of
  `(review-loop round N)` markers in `git log <base>..HEAD`.
- **Lazy.** On any non-actionable state (awaiting Copilot, max rounds
  reached, Copilot not available), print a one-line status and exit.
- **Token-efficient.** Hand the antagonist agent only the Copilot
  comments JSON path + (optionally) the spec path. Do not forward
  conversation context.

### No-findings close-out

Copilot can close a round via an issue-comment acknowledgment (e.g.
"No additional code changes were needed") instead of a real review —
see `references/workflow.md` Phase 3 / 3z for the detection and
close-out behavior. Override the match pattern via
`REVIEW_LOOP_NO_FINDINGS_PATTERN` (jq Oniguruma syntax).
