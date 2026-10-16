---
name: clipboard-img
description: Extract an image from the system clipboard and save it as PNG. Supports WSL, Wayland, and X11. Use when the user wants to paste, grab, or save a screenshot from the clipboard.
---

# /clipboard-img — Grab Clipboard Image

Save the current clipboard image as a PNG file.

**Usage:**

- `/clipboard-img` — save to `$(stash -a -u clipboard .png)` (default)
- `/clipboard-img --scratch` / `-s` — save to an ephemeral temp file, `$(stash -u clipboard .png)` (path printed to stdout)
- `/clipboard-img photo.png` — save to a specific filename
- `/clipboard-img -` — write raw PNG to stdout (for piping)

## Execution

Run the helper script with any user-supplied arguments:

```
clipboard-image $ARGS
```

Where `$ARGS` is the optional filename or `-` from the user's invocation.

## After Success

1. Report the saved filename (printed to stdout by the script).
1. If the user provided no arguments, mention the auto-generated filename.
1. Read the saved image with the Read tool so the user can see it inline.

## On Failure

- **Exit 1 "no supported clipboard backend"** — relay the install hints from stderr.
- **Exit 1 "no image on clipboard"** — tell the user no image was found. Suggest copying an image first (e.g. Win+Shift+S on Windows/WSL, or a screenshot tool).
