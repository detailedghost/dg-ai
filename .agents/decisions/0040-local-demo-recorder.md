---
covers: ["pkg/skills-cli/src/demo/recorder/**", "pkg/skills-cli/src/demo/verify-local.ts", "pkg/common/src/plan-format.ts", "plugins/dg/skills/demo/**"]
---

[ADR 0040](../../docs/adr/0040-local-demo-recorder.md)

- Make local `dg-skills demo` always record with the Node recorder. Keep the interactive tour behind `--ext`.
- Draw overlays with plain DOM through `page.evaluate`. Never rely on an in-page script that a site Content Security Policy can block.
- Resolve only `$DG_DEMO_*` variables (`^\$DG_DEMO_[A-Z0-9_]+$`) in `@type`. Reject any other variable-looking value in `validate()`.
- Type an env reference only into `input[type=password]`. Never put the value in a plan, log or result.
- Refuse a recorded step with an unset `$DG_DEMO_*` variable with exit 2.
- Run `## Setup` with `includeSetup: false` in an unrecorded context and hand its login to the recording.
- Refuse the human-fallback window on a headless-only plan with exit 2.
- Keep `-n` / `--narration` a plain switch, off by default. Make the Kokoro voice before recording, on a page the recorder controls, and mux it as AAC.
- Encode H.264 MP4 at 1440x810 and 30 fps, and check it with `ffprobe`. Require `--out` to end in `.mp4` and sit outside a git work tree.
- Without `ffmpeg`, keep the raw webm and warn.
- Run `--verify <plan>` as a dry run with no overlays and no holds. Report only `selector-unresolved`, `env-unset`, `plan-unreadable` and `harness-error`.
- Find the browser in one finder shared with `pw`. Suggest `dg-skills pw install-browser` only when the finder finds none.
- Keep `--video` accepted and without effect in local mode.
