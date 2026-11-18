# Demo local player: /dg:demo plays the tour in a Playwright-driven browser by default, --ext keeps the extension flow — Initial Notes

## Purpose
Plain `/dg:demo` no longer needs the dg-ai-extension. The CLI launches a browser with the pw skill's rules (system Chrome or Edge first, the Windows browser over CDP on WSL, headless Chromium as the fallback, install-browser when none), injects the same tour overlay the extension renders, shows the same start screen in the page (review, walkthrough, video, narration and voice) and records a video file next to the saved plan. The overlay, step engine, start screen and editor move into a shared pkg/tour-ui package behind a small host interface so the extension and the local player run one implementation. `--ext` is today's flow through the extension; `--verify` walks the plan in the local player unless --ext is given.

## Scope
### Included
- pkg/tour-ui: overlay, step renderer, start screen, editor and video sequencing extracted from the extension behind a TourHost interface; the extension's WXT host; a Bun-built IIFE player bundle for injection
- dg-skills demo local mode: detached player process, browser from pw's pickLaunch and wslPlan, start screen in page, walkthrough and video, result file, `demo status`
- Local --verify that walks the player's overlay; --ext --verify keeps the extension harness
- Local narration: Kokoro in the page with the ORT wasm and model fetched on demand, a sidecar WAV and an optional ffmpeg mux [ASSUMED, see Open questions]
- demo and rerun skills and docs: local default, --ext documented in references/extension.md, flags table, doctor browser status, ADR 0029
### Excluded
- Changes to the TourScript plan format or authoring.md grammar
- Recording through tabCapture or the extension's offscreen document in local mode
- Firefox or WebKit as local demo browsers
- The --ext convention itself (bundle 014) and the pw browser rules (bundle 009)
