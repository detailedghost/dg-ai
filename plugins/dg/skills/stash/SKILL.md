---
name: stash
description: "Print where to store a file."
---

Resolve the CLI before using the commands below:

```bash
DG="$HOME/.dg/bin/dg-skills"
if [ ! -x "$DG" ]; then
  LOCAL_BOOTSTRAP="${CLAUDE_PLUGIN_ROOT:-}/pkg/skills-cli/bootstrap.sh"
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "$LOCAL_BOOTSTRAP" ]; then
    sh "$LOCAL_BOOTSTRAP"
  else
    curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/master/pkg/skills-cli/bootstrap.sh | sh
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
Never build these paths by hand. Move between roots with copy + unlink, never `mv`.
