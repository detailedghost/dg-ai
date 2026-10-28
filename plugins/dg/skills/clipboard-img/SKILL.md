---
name: clipboard-img
description: Extract an image from the system clipboard and save it as PNG. Supports WSL, Wayland, and X11. Use when the user wants to paste, grab, or save a screenshot from the clipboard.
---

First run: install or refresh the CLI when it is missing or too old. Every later call uses the literal path, so each Bash call works alone:

```bash
~/.dg/bin/dg-skills clipboard-image --help >/dev/null 2>&1 ||
  curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh -s -- --cli-only
```

If a step fails, run ~/.dg/bin/dg-skills doctor clipboard-image stash.

# /dg:clipboard-img — Grab Clipboard Image

Save the current clipboard image as a PNG file.

**Usage:** `/dg:clipboard-img [--scratch | -s | <dest.png> | -]`

- `/dg:clipboard-img` — save to `$(~/.dg/bin/dg-skills stash -a -u clipboard .png)` (default)
- `/dg:clipboard-img --scratch` / `-s` — save to an ephemeral temp file, `$(~/.dg/bin/dg-skills stash -u clipboard .png)` (path printed to stdout)
- `/dg:clipboard-img photo.png` — save to a specific filename
- `/dg:clipboard-img -` — write raw PNG to stdout (for piping)

## Flags

| Flag | Short | Effect | Default |
|---|---|---|---|
| `--scratch` | `-s` | Save to an ephemeral temp file and print its path. | off |
| `<dest.png>` | none | Save to this filename. | a unique repo artifact path |
| `-` | none | Write the raw PNG to stdout. | off |

## Execution

For the default destination, resolve a unique repo artifact path and pass it as one argument:

```bash
OUTPUT="$(~/.dg/bin/dg-skills stash -a -u clipboard .png)"
~/.dg/bin/dg-skills clipboard-image "$OUTPUT"
```

For the skill's `--scratch` / `-s` option, resolve `OUTPUT` with `~/.dg/bin/dg-skills stash -u clipboard .png` instead. For an explicit filename, pass that literal filename as one argument. Pass `-` to write PNG bytes to stdout. The compiled command uses the system clipboard tools and requires no legacy helper on PATH.

## After Success

With `-`, the PNG goes to stdout and no file exists. Skip these steps.

1. Report the saved filename (printed to stdout by the script).
1. If the user provided no arguments, mention the auto-generated filename.
1. Read the saved image with the Read tool so the user can see it inline.

## On Failure

- **Exit 1 "no supported clipboard backend"** — relay the install hints from stderr.
- **Exit 1 "no image on clipboard"** — tell the user no image was found. Suggest copying an image first (e.g. Win+Shift+S on Windows/WSL, or a screenshot tool).
