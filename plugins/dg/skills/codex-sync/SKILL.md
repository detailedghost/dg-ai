---
name: codex-sync
description: Reconcile a Claude-to-Codex setup after using Codex's built-in Import flow -- status line, agent model tiers, hooks, and skills. Codex-only; do not route to Copilot or OpenCode sync.
---

# /dg:codex-sync — Reconcile Claude Assets for Codex

A thin router over `/dg:sync`'s `codex` target. See `/dg:sync` for the full contract, source precedence, and secret handling.

Codex's own built-in Settings Import already copies Claude subagents, skills, MCP, and hooks into `$CODEX_HOME` once, as raw content. This command reconciles Codex-specific incompatibilities afterward: translates the status line, adapts hook payloads for `apply_patch`, translates agent model tiers, and adapts imported skill frontmatter.

First run: install or refresh the CLI when it is missing or too old. Every later call uses the literal installed path:

```bash
~/.dg/bin/dg-skills sync --help >/dev/null 2>&1 ||
  curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.19.0/pkg/skills-cli/bootstrap.sh | sh -s -- --cli-only
```

If a step fails, run ~/.dg/bin/dg-skills doctor sync.

**Usage:** `~/.dg/bin/dg-skills sync codex <probe|dry-run|apply|verify>`

## Workflow

1. Run Codex's built-in Import flow when Claude's own setup changes.
2. `~/.dg/bin/dg-skills sync codex probe`
3. `~/.dg/bin/dg-skills sync codex dry-run`
4. `~/.dg/bin/dg-skills sync codex apply`
5. `~/.dg/bin/dg-skills sync codex verify`
6. When hook definitions changed, open `/hooks` and trust the reviewed definitions. Never synthesize or write Codex's private trust hashes.

> **Not the Copilot or OpenCode variant.** Use `/dg:copilot-sync` for `~/.copilot`, or `/dg:opencode-sync` for `~/.config/opencode`.
