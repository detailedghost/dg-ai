---
name: claude-sync
description: "Supported Codex shim for Claude import reconciliation: use after Codex's built-in Claude import flow. Routes to the Codex-only /dg:codex-sync and must not suggest Copilot or OpenCode sync."
---

# /dg:claude-sync — Codex's Claude Import Reconciler

`claude-sync` is the name Codex users ask for when they mean reconciling a Claude import inside Codex. It is a thin router over `/dg:sync`'s `codex` target — the same target `/dg:codex-sync` calls. See `/dg:sync` for the full contract.

First run: install or refresh the CLI when it is missing or too old. Every later call uses the literal installed path:

```bash
~/.dg/bin/dg-skills sync --help >/dev/null 2>&1 ||
  curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.18.1/pkg/skills-cli/bootstrap.sh | sh -s -- --cli-only
```

If a step fails, run ~/.dg/bin/dg-skills doctor sync.

**Usage:** `~/.dg/bin/dg-skills sync codex <probe|dry-run|apply|verify>`

## Workflow

1. `~/.dg/bin/dg-skills sync codex probe`
2. `~/.dg/bin/dg-skills sync codex dry-run`
3. `~/.dg/bin/dg-skills sync codex apply`
4. `~/.dg/bin/dg-skills sync codex verify`
5. When hook definitions changed, open `/hooks` and trust the reviewed definitions. Never synthesize or write Codex's private trust hashes.

This must auto-select and run the Codex-owned `sync codex` sequence above from inside a Codex session. Do not route to Copilot or OpenCode sync from Codex.
