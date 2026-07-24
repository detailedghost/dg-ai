# @dg/extension — dg-ai-extension

WXT MV3 browser extension. Features: tab grouping, guided demo tours with video
recording and TTS narration, and live-page prototype comparisons.

## Development commands

```bash
bun install          # from repo root (wires @dg/common)
bun run dev          # WXT dev server with hot reload
bun run build        # production build → .output/
bun run lint         # tsc --noEmit
bun test             # unit tests (45 specs)
bun run zip          # build + package for Chrome
bun run zip:firefox  # build + package for Firefox
```

## Loading in Chrome

1. Run `bun run build` (or `bun skills/browser ... install`)
1. Open `chrome://extensions` → Enable Developer Mode
1. Load Unpacked → select `.output/chrome-mv3/`

See [docs/AGENT-INSTALL.md](../../docs/AGENT-INSTALL.md) for full setup.

## Live-page prototypes

The `/dg:proto` skill and `dg-skills proto` commands use the extension to sample
a bounded set of page styles, render sanitized HTML/CSS variations in an
isolated shadow root, collect an explicit approve/reject verdict, and optionally
save a visible-tab preview. Style guides, verdicts, and previews use the local
Downloads directory; the extension does not upload prototype data.

The `_proto` handoff travels in a compressed URL fragment. The browser does not
send fragments to the page server, but page scripts can read them before the
extension removes them. Prototype plans must not contain secrets.
