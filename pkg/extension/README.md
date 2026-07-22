# @dg/extension — dg-ai-extension

WXT MV3 browser extension. Features: tab grouping, guided demo tours with video recording and TTS narration.

## Dev Commands

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
2. Open `chrome://extensions` → Enable Developer Mode
3. Load Unpacked → select `.output/chrome-mv3/`

See [docs/AGENT-INSTALL.md](../../docs/AGENT-INSTALL.md) for full setup.
