---
name: clipboard-img
description: Extract an image from the system clipboard and save it as PNG. Supports WSL, Wayland, and X11. Use when the user wants to paste, grab, or save a screenshot from the clipboard.
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

# /clipboard-img — Grab Clipboard Image

Save the current clipboard image as a PNG file.

**Usage:**

- `/clipboard-img` — save to `$("$DG" stash -a -u clipboard .png)` (default)
- `/clipboard-img --scratch` / `-s` — save to an ephemeral temp file, `$("$DG" stash -u clipboard .png)` (path printed to stdout)
- `/clipboard-img photo.png` — save to a specific filename
- `/clipboard-img -` — write raw PNG to stdout (for piping)

## Execution

For the default destination, resolve a unique repo artifact path and pass it as one argument:

```bash
OUTPUT="$("$DG" stash -a -u clipboard .png)"
"$DG" clipboard-image "$OUTPUT"
```

For the skill's `--scratch` / `-s` option, resolve `OUTPUT` with `"$DG" stash -u clipboard .png` instead. For an explicit filename, pass that literal filename as one argument. Pass `-` to write PNG bytes to stdout. The compiled command uses the system clipboard tools and requires no legacy helper on PATH.

## After Success

1. Report the saved filename (printed to stdout by the script).
1. If the user provided no arguments, mention the auto-generated filename.
1. Read the saved image with the Read tool so the user can see it inline.

## On Failure

- **Exit 1 "no supported clipboard backend"** — relay the install hints from stderr.
- **Exit 1 "no image on clipboard"** — tell the user no image was found. Suggest copying an image first (e.g. Win+Shift+S on Windows/WSL, or a screenshot tool).
