# Guided tours and live-page prototypes

Show off a feature with a guided demo. Plain `/dg:demo` records an MP4 in a local
browser that the CLI starts, with no extension. A recorder clicks and types in the
real UI, and adds chapter cards, captions, and a highlight on each target. Add
`--ext` to play a live, interactive tour in your real browser through the extension
instead:

```text
Claude Code: /dg:demo 1517
Codex:      $dg:demo 1517
```

Local mode has no start screen. It records at once and saves
`<cacheDir>/demos/<slug>/<slug>-<stamp>.mp4`. Add `-n` for a Kokoro voice. Pass
`--out <file>.mp4` to pick the path. Install `ffmpeg` for MP4 output. With `--ext`,
you review the plan in the extension, and video lands in your Downloads folder.
Type a secret with `@type="$NAME"` in the plan. The recorder reads env var `NAME`,
and the plan never holds the value.

Tours can include a setup phase for login, configuration, or seeded data. Setup
is excluded from the tutorial and recording by default, but can be explicitly
included as the opening steps. See [ADR 0040](adr/0040-local-demo-recorder.md).

Prototype before you build. Plain `/dg:proto` runs the **local mode**, which
needs no browser extension:

```text
Claude Code: /dg:proto settings page layout
Codex:      $dg:proto settings page layout
```

The local mode picks the shape from the question. A state or logic question
becomes a runnable terminal app. A look question becomes five variations by
default (`-n <count>` or `-o "<a>,<b>"` change that) on one route, served by
`dg-skills prototype serve` with Approve, Reject, and notes. A multi-workflow
plan becomes one clickable walkthrough. Approve with a note starts a new round
from the pick, `tweak` edits in place, and `-c` resumes an open chain.

Add `--ext` to explore app-native approaches directly inside a live page, then
export the one you approve:

```text
Claude Code: /dg:proto --ext
Codex:      $dg:proto --ext
```

The extension workflow asks for a page and design question, samples the page's
visual styles, presents the proposed comparison, and plants the approved set in
the browser. Run the browser skill's `install` command first to load the
companion extension. For authenticated or private pages, review the privacy
warning before allowing the style scrape. The CLI writes approved answers under
`.agents/prototype/<slug>/` and removes temporary Downloads and scratch files
after export.

Plain `/dg:proto` used to run the extension workflow. It now runs the local
mode, so add `--ext` to keep the extension workflow. The CLI form follows:
`dg-skills proto --ext plant <plan>`.

See the [demo skill](../plugins/dg/skills/demo/SKILL.md),
[TourScript authoring guide](../plugins/dg/skills/demo/references/authoring.md),
and [prototype skill](../plugins/dg/skills/proto/SKILL.md).

Finished work, which has no variants to pick from, uses
[/dg:verify](verify.md). That page shows before, after, and a prototype target
when one is already running.
