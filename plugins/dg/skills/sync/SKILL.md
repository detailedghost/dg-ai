---
name: sync
description: Sync Claude-authored skills and agents into other AI tools (Copilot, OpenCode, Codex, Pi, Grok), and report where the dg plugin and the local Claude directories disagree.
---

# Syncing Claude Assets with sync

First run: install or refresh the CLI when it is missing or too old. Every later call uses the literal installed path:

```bash
~/.dg/bin/dg-skills sync --help >/dev/null 2>&1 ||
  curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.18.1/pkg/skills-cli/bootstrap.sh | sh -s -- --cli-only
```

If a step fails, run ~/.dg/bin/dg-skills doctor sync credentials.

## Quick start

```bash
~/.dg/bin/dg-skills sync copilot apply
~/.dg/bin/dg-skills sync opencode apply
~/.dg/bin/dg-skills sync codex apply
~/.dg/bin/dg-skills sync pi apply
~/.dg/bin/dg-skills sync grok apply
```

## Usage

**Usage:** `~/.dg/bin/dg-skills sync <copilot|opencode|codex|claude|pi|grok> <probe|dry-run|apply|verify> [--copy-skills] [--sync-dtf]`

## Flags

| Flag | Short | Effect | Default |
|---|---|---|---|
| `--copy-skills` | none | Copilot only: copy the merged skill set into `~/.copilot/skills` instead of symlinking it. Copying happens automatically whenever the dg plugin contributes any skill, even without this flag. | symlink when only the local Claude skills directory contributes |
| `--sync-dtf` | none | OpenCode only: accepted for legacy-caller compatibility; prints a note and has no effect. The old dotfile-tracker integration this flag drove is a manual local step now. | off |

## Targets

Each target supports the same four verbs:

```bash
~/.dg/bin/dg-skills sync <target> probe      # discover sources and destinations; no writes
~/.dg/bin/dg-skills sync <target> dry-run    # print planned operations; no writes
~/.dg/bin/dg-skills sync <target> apply      # sync, then self-verify
~/.dg/bin/dg-skills sync <target> verify     # validate the synced state without changing it
```

- **copilot** — syncs skills, subagents (as `*.agent.md`), hooks, MCP servers, and a converted `CLAUDE.md` into `~/.copilot`.
- **opencode** — syncs skills, subagents, hooks, and plugins into `~/.config/opencode`, and registers plugin names in `opencode.json`.
- **codex** — reconciles Codex's own built-in asset import: translates the status line and agent model tiers, adapts hook payloads, and imports skills/subagents with Codex-specific fixups. Does not write anything under `~/.local/bin`; Codex calls this CLI directly.
- **claude** — diagnostic only. Claude Code already loads the dg plugin and the local Claude skills and agents directly, so this target never writes anything; it only reports where the plugin and local copies define the same name.
- **pi** — mirrors the merged skill set into Pi's own skill directory, unmodified (Pi reads Claude-format `SKILL.md` natively). Agents, hooks, MCP servers, and the status line are not synced to Pi.
- **grok** — mirrors the merged skill set into Grok's own skill directory. Grok already scans the local Claude skills directory natively when its Claude-compatibility setting is on; this only fills the gap for skills that live solely in the dg plugin tree.

## Sources and precedence

Every target merges two sources: the dg plugin's own skills and agents, and whatever still lives under the local Claude skills and agents directories. When both sources define the same name, the plugin's copy wins and the command reports it as a warning — the local copy is never deleted or modified. Source roots are configurable: set `DG_SKILLS_DIR` to point at an installed or checked-out plugin skills directory, or `SKILLS_SRC`/`AGENTS_SRC` to point at a different local Claude directory.

## Pruning

Each target only removes files or directories it wrote on a previous `apply`, tracked in a small manifest beside the destination. A file that was never produced by this command is never touched, even if it looks like a stale skill or agent.

## Secrets

OpenCode's MCP configuration may reference `${VAR}` environment variables. Instead of reading a personal secrets file, `apply` resolves each one through the dg-daemon credential store, under the name `sync/<var-lowercased-with-dashes>` (for example `CONTEXT7_API_KEY` resolves `sync/context7-api-key`). A missing credential fails `apply` with the exact name to set:

```bash
~/.dg/bin/dg-skills credentials set sync/context7-api-key
```

## Trust and permissions

Hook trust, Codex's `/hooks` review, and any permission or settings file edit stay manual steps for the user. This command never writes to a tool's permission rules.

## Notes

- `copilot` and `opencode` `verify` also run a secret-wall scan over the MCP config they write, failing if a literal secret-shaped value appears instead of an environment reference. `codex` runs its own narrower check against the Context7 MCP block it writes. `pi` and `grok` only mirror skill files, which carry no secrets, so they run neither.
- `/dg:doctor` reports whether the required skill files and the `sync` allow rule are in place.
