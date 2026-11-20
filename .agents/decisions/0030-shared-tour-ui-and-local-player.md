---
covers: ["pkg/tour-ui/**", "pkg/skills-cli/src/demo/**", "plugins/dg/skills/demo/**"]
---

[ADR 0030](../../docs/adr/0030-shared-tour-ui-and-local-player.md)

- Keep the DOM-only tour UI in `pkg/tour-ui` behind the `TourHost` interface. The extension and the Playwright-injected player are two hosts of one implementation.
- Never duplicate the overlay in the CLI or inject the extension content script into the player.
- Ship the player as an injected IIFE text asset inside the demo chunk, not the stash chunk.
- Make `dg-skills demo` spawn a detached player process that reports through the bridge and `result.json`. `demo status <slug>` reads `result.json`.
- Run narration in the page. Download Kokoro assets on the first voiced run and check them against `SHA256SUMS`.
- Write a sidecar WAV aligned to each step start. Merge it into the video only when `ffmpeg` exists.
- When a site Content Security Policy blocks the in-page voice, record without voice and say why.
- Keep `--ext` as the path for tab-capture video in the user's own browser.
