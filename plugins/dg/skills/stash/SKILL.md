---
name: stash
description: "Print an absolute path for a scratch, state, or worktree-local file. Use when a skill or task needs somewhere to write drafts, run state, handoffs, or per-repo agent artifacts."
---

First run: install or refresh the CLI when it is missing or too old. Every later call uses the literal path, so each Bash call works alone:

```bash
dg-skills stash --help >/dev/null 2>&1 ||
  "$HOME/.local/bin/dg-skills" stash --help >/dev/null 2>&1 ||
  curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh -s -- --cli-only
```

Call `dg-skills` in every later step. If only the second line answered, call `$HOME/.local/bin/dg-skills` instead.

If a step fails, run dg-skills doctor stash.

`dg-skills stash <tool> [name]` prints one absolute path and creates its parent. No name prints the dir.

| Flag | Root | Lives |
|---|---|---|
| (none) `--scratch` | `$AI_SCRATCH_DIR/<tool>/<cwd-hash>` | reboot or 14 d |
| `-s` `--state` | `$AI_STATE_DIR/<tool>/<project-hash>` | 30 d |
| `-a` `--agents` | `<worktree>/.agents/<tool>` | with the repo; git-ignored files pruned after 30 d |
| `-m` `--main` | `<main worktree>/.agents/<tool>` | same as `-a` |

`-G --global` no bucket · `-u --unique` unique name (a given name becomes the suffix) · `-r --root` root only · `-C --dir <dir>` bucket for another dir.
A scratch or state root with a group or other write bit (mode `0022` mask) is rejected, even when you own it. Create it with mode `0700` or run `chmod go-w` on it.
Never build these paths by hand. Move between roots with copy + unlink, never `mv`.
