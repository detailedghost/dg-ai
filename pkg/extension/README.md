# @dg/extension — dg-ai-extension

WXT MV3 browser extension. Features: tab grouping, guided demo tours with video
recording and TTS narration, live-page prototype comparisons, and
provider-neutral mailbox cleanup.

## Development commands

```bash
bun install          # from repo root (wires @dg/common)
bun run dev          # WXT dev server with hot reload
bun run build        # production build → .output/
bun run lint         # tsc --noEmit
bun test             # unit and integration tests
bun run conformance:mailbox-core  # mailbox core gate
bun run zip          # build + package for Chrome
bun run zip:firefox  # build + package for Firefox
```

## Loading in Chrome

1. Run `bun run build` (or `bun skills/browser ... install`)
1. Open `chrome://extensions` → Enable Developer Mode
1. Load Unpacked → select `.output/chrome-mv3/`

See [docs/AGENT-INSTALL.md](../../docs/AGENT-INSTALL.md) for full setup.

## Guided demos

Tour scripts may include an optional setup phase for login, configuration,
seeded data, or other preparation. Setup is reviewed in the extension editor.
When excluded (the default), it runs user-paced before the tutorial and before
video capture starts. When explicitly included, its steps lead the tutorial,
narration, and recording.

Auth secrets must never be stored in setup fill actions. Marker-provided
automatic actions require explicit approval before playback, and recording
remains blocked until setup has handed off to the tutorial.

## Live-page prototypes

The `/dg:proto` skill and `dg-skills proto` commands use the extension to sample
a bounded set of page styles, render sanitized HTML/CSS variations in an
isolated shadow root, collect an explicit approve/reject verdict, and optionally
save a visible-tab preview. Style guides, verdicts, and previews use the local
Downloads directory; the extension does not upload prototype data.

The `_proto` handoff travels in a compressed URL fragment. The browser does not
send fragments to the page server, but page scripts can read them before the
extension removes them. Prototype plans must not contain secrets.

## Mailbox cleanup

The extension includes the provider-neutral mailbox cleanup workflow, plan
workspace, safe execution engine, plan-list/restart bridge, and fake-provider
conformance suite. The canonical privacy, retention, restart, limits, provider
handoff, and conformance-gate documentation is
[Mailbox Cleanup Core](../../docs/mailbox-cleanup/core.md).
