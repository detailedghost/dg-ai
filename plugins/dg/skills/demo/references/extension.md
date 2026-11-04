# Demo through the extension (`--ext`)

Pass `--ext` to play a tour through the dg-ai-extension in the user's own browser.
The plan format is the same as the local flow. See [authoring.md](authoring.md).

```bash
dg-skills demo --ext /tmp/ai/demo/tour.md
dg-skills rerun --ext <path-to>.demo.md
```

## Review panel

`--edit` (with `--ext`) opens the review panel before the tour plays. Locally, the
start screen always offers Review. Known limit: the local review panel keeps its draft only while the page stays on one URL.

## Recording

For a video, excluded setup runs first. After the handoff, the user presses
`Alt+Shift+D` (or clicks the DeeGee toolbar icon) to start recording. The tour then
auto-plays and saves `dg-demo/<tour>/<tour>.webm` and
`dg-demo/<tour>/<tour>.demo.md` to the user's Downloads folder.

Recording uses `tabCapture` and an offscreen document, so it works in Chrome and
Edge only. The first narrated run downloads the Kokoro model (about 86 MB). If
synthesis fails, the video still records without voice.

## Verify with the extension

`demo --ext --verify <plan>` walks the plan through the extension harness. It needs
a built extension (`bun run --filter='@dg/extension' build`) and a browser that can
load it. Plain `--verify` needs neither.

## Dev checkout

The browser runs the extension, not the CLI. After you change extension code,
rebuild and re-stage it:

```bash
bun run --filter='@dg/extension' build
dg-skills install --local
```

Then reload the extension in `chrome://extensions`. On WSL, the loaded copy is the
Windows staging directory, not `.output/`.
