---
name: hooks
description: Turn the opt-in dg hooks on or off for Claude, Codex, and opencode, and report which are on. Hooks are off by default. Always ask the user before enabling any hook.
---

# /dg:hooks

Manage the dg hooks. No hook is on by default. `enable` writes the user's
tool settings, so it needs the user's yes first.

First run: install or refresh the CLI when it is missing or too old.

```bash
dg-skills hooks list >/dev/null 2>&1 ||
  "$HOME/.local/bin/dg-skills" hooks list >/dev/null 2>&1 ||
  curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh -s -- --cli-only
```

Call `dg-skills` in every later step. If only the second line answered, call `$HOME/.local/bin/dg-skills` instead.

If a step fails, run dg-skills doctor hooks.

## Hooks

- `spelling`: reject the other English locale's spellings in text from Edit or Write. Setting `locale`: `en-US` (default) or `en-GB`.
- `format`: format the edited file with the formatter installed for its type.
- `pr-prose`: block a PR or MR body that is not plain English.
- `pr-confirm`: ask before a PR or MR is created. Claude only, because Codex runs the command when a hook asks.
- `spec-plan-lint`: validate a spec `plan.md` after it is written.
- `strip-ai-coauthors`: remove AI `Co-Authored-By` trailers from commit messages. `enable` installs a git `commit-msg` hook in the current repo, chains any existing one, and turns the setting on; `disable` restores the old hook and turns it off. Also read by `meaningful apply-json`. `DG_STRIP_AI_COAUTHORS=1` or `0` overrides the setting.
- `daily-prune`: once a day, remove scratch and state past TTL and merged clean worktrees. Claude and Codex only.

## Commands

- `dg-skills hooks status`: run this when asked what is on. Report per runtime.
- `dg-skills hooks enable <id>... [--runtime <runtime>] [--set locale=en-GB]`
- `dg-skills hooks disable <id>|--all [--runtime <runtime>]`

## Ask first

Ask the user before enabling any hook. Name the hook, what it does, and each
runtime file it will change. Run `enable` only after the user answers yes. This
applies in every mode, including auto. Never enable a hook to fix a failing
task. `disable` needs no question.

Changes take effect in new sessions. Hooks are slower than plain shell hooks
until the latency budget lands, so tell users they can keep their own.

Paths, the owned marker, and uninstall: [docs/hooks.md](https://github.com/detailedghost/dg-ai/blob/master/docs/hooks.md).
