---
name: update
description: Update every dg part to the newest release with one command. Checks what is behind first, asks, then refreshes the Bun runtime, the dg bundle and launchers, the staged dg-ai-extension, and the dg plugin for Claude and Codex, and runs doctor. Use when doctor says a part is older, a dg skill calls a command that is missing, or you ask to update dg.
---

# Skill: update

First run: install or refresh the CLI when it is missing or too old. Each Bash call works alone:

```bash
dg-skills update --help 2>&1 | grep -q -- --check ||
  "${DG_HOME:-$HOME/.local}/bin/dg-skills" update --help 2>&1 | grep -q -- --check ||
  curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh
```

Call `dg-skills` in every later step. If `dg-skills` alone does not answer, also after the bootstrap, call `${DG_HOME:-$HOME/.local}/bin/dg-skills` instead.

An older CLI has no `update` command and prints its general help instead, so the check looks for the `--check` flag. The bootstrap is a full install. On a machine set up with `--cli-only`, end that line with `| sh -s -- --cli-only` instead, so it stays CLI-only.

If a step fails, run dg-skills doctor update install.

## Usage

**Usage:** `/dg:update`

## Flags

| Flag | Short | Effect | Default |
|---|---|---|---|
| `--check` | none | Print installed and newest versions and change nothing. The skill always runs it first. | off |

## Run

1. Run `dg-skills update --check`. Exit 0 means every part is current: say so and stop. Exit 1 means a part is behind: show the lines.
2. Say what the update changes: it downloads the release, replaces the runtime, bundle and launchers, stages the extension, and runs `claude plugin` and `codex plugin` commands. Ask before you go on. On a no, stop.
3. Run `dg-skills update`. Each step prints ✅, ⏭️ or ❌, then a doctor summary.
4. Report each step in one line. For a ❌ step, give its message and the doctor item to check.
5. Tell the user to restart Claude Code and Codex sessions so the new skills load, and to reload the dg-ai-extension.

To install one exact release instead of the newest, use `dg-skills install --version <x.y.z>`. `update` always goes to the newest release, because the plugins can only follow their marketplace.

## Rules

- Never run `dg-skills update` without the yes in step 2.
- Exit 1 after the update means a step failed. The other steps still ran. Do not run it again in a loop.
