---
name: opencode-sync
description: "OpenCode-only: sync Claude-authored skills, agents, hooks, and plugins into ~/.config/opencode. Distinct from /dg:copilot-sync (targets ~/.copilot) and /dg:codex-sync (targets Codex)."
---

# /dg:opencode-sync — Sync Claude Assets into OpenCode

A thin router over `/dg:sync`'s `opencode` target. See `/dg:sync` for the full contract, source precedence, and secret handling.

First run: install or refresh the CLI when it is missing or too old. Every later call uses the literal installed path:

```bash
~/.dg/bin/dg-skills sync --help >/dev/null 2>&1 ||
  curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.18.1/pkg/skills-cli/bootstrap.sh | sh -s -- --cli-only
```

If a step fails, run ~/.dg/bin/dg-skills doctor sync.

**Usage:** `~/.dg/bin/dg-skills sync opencode <probe|dry-run|apply|verify>`

## Default workflow

```bash
~/.dg/bin/dg-skills sync opencode dry-run
~/.dg/bin/dg-skills sync opencode apply
~/.dg/bin/dg-skills sync opencode verify
```

> **Not the Copilot or Codex variant.** Use `/dg:copilot-sync` for `~/.copilot`, or `/dg:codex-sync` for Codex.
