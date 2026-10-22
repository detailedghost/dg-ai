---
name: copilot-sync
description: "Copilot-only: sync Claude-authored skills, agents, hooks, MCP servers, and instructions into ~/.copilot. Distinct from /dg:opencode-sync (targets OpenCode) and /dg:codex-sync (targets Codex)."
---

# /dg:copilot-sync — Sync Claude Assets into Copilot

A thin router over `/dg:sync`'s `copilot` target. See `/dg:sync` for the full contract, source precedence, and secret handling.

First run: install or refresh the CLI when it is missing or too old. Every later call uses the literal installed path:

```bash
~/.dg/bin/dg-skills sync --help >/dev/null 2>&1 ||
  curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.19.0/pkg/skills-cli/bootstrap.sh | sh -s -- --cli-only
```

If a step fails, run ~/.dg/bin/dg-skills doctor sync.

**Usage:** `~/.dg/bin/dg-skills sync copilot <probe|dry-run|apply|verify>`

## Default workflow

```bash
~/.dg/bin/dg-skills sync copilot dry-run
~/.dg/bin/dg-skills sync copilot apply
~/.dg/bin/dg-skills sync copilot verify
```

See `/dg:sync` for the `--copy-skills` flag.

> **Not the OpenCode or Codex variant.** Use `/dg:opencode-sync` for `~/.config/opencode`, or `/dg:codex-sync` for Codex.
