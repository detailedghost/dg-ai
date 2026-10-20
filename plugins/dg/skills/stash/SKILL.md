---
name: stash
description: "Print an absolute path for a scratch, state, or worktree-local file. Use when a skill or task needs somewhere to write drafts, run state, handoffs, or per-repo agent artifacts."
---

Resolve the CLI before using the commands below:

```bash
DG="${DG_HOME:-$HOME/.dg}/bin/dg-skills"
if [ ! -x "$DG" ]; then
  LOCAL_BOOTSTRAP="${CLAUDE_PLUGIN_ROOT:-}/pkg/skills-cli/bootstrap.sh"
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "$LOCAL_BOOTSTRAP" ]; then
    sh "$LOCAL_BOOTSTRAP"
  else
    curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.16.0/pkg/skills-cli/bootstrap.sh | sh
  fi
fi
```

`"$DG" stash <tool> [name]` prints one absolute path and creates its parent. No name prints the dir.

| Flag | Root | Lives |
|---|---|---|
| (none) `--scratch` | `$AI_SCRATCH_DIR/<tool>/<cwd-hash>` | reboot or 14 d |
| `-s` `--state` | `$AI_STATE_DIR/<tool>/<project-hash>` | 30 d |
| `-a` `--agents` | `<worktree>/.agents/<tool>` | with the repo; git-ignored files pruned after 30 d |
| `-m` `--main` | `<main worktree>/.agents/<tool>` | same as `-a` |

`-G --global` no bucket · `-u --unique` unique name (a given name becomes the suffix) · `-r --root` root only · `-C --dir <dir>` bucket for another dir.
A scratch or state root with a group or other write bit (mode `0022` mask) is rejected, even when you own it. Create it with mode `0700` or run `chmod go-w` on it.
Never build these paths by hand. Move between roots with copy + unlink, never `mv`.
