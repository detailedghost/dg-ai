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
Type a password with `@type="$DG_DEMO_VELORA_PW"` in the plan. Only `$DG_DEMO_*`
variables resolve, and only into password fields. The plan never holds the value.

Local recording uses its own Playwright recorder and stays local in every
`pw.mode`, so video never drives your real profile. `--ext` plays through
the extension in the agent window, and the first visit to each new site opens
the allow popup. `demo` and `proto` read `--ext` as an explicit flag; `auto`
mode does not switch them. See [browser mode](pw.md#browser-mode-auto-ext-and-local).

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
`dg prototype serve` with Approve, Reject, and notes. A multi-workflow
plan becomes one clickable walkthrough. Approve with a note starts a new round
from the pick, `tweak` edits in place, and `-c` resumes an open chain.

`prototype wait` and `prototype await-decision` exit 0 for a decision and 124
on a timeout, with the pick still pending. `wait` exits 75 when the approve is
recorded but the layout fingerprint was skipped, and prints the `run:` line
that repairs it. For a page behind a login, pass `--sign-in=<url>` or
`--state=<pw state name>` to `prototype ui`, `wait`, or `fingerprint`. A
hand-written in-app bar needs Approve, Reject, More versions, and notes.

Add `--ext` to explore app-native approaches directly inside a live page, then
export the one you approve:

```text
Claude Code: /dg:proto --ext
Codex:      $dg:proto --ext
```

The extension workflow asks for a page and design question, samples the page's
visual styles, presents the proposed comparison, and plants the approved set in
the browser. Run `dg install` first to load the
companion extension. For authenticated or private pages, review the privacy
warning before allowing the style scrape. The CLI writes approved answers under
`.agents/prototype/<slug>/` and removes temporary Downloads and scratch files
after export.

The local fingerprint capture uses Playwright and stays local in every mode.

Plain `/dg:proto` used to run the extension workflow. It now runs the local
mode, so add `--ext` to keep the extension workflow. The CLI form follows:
`dg proto --ext plant <plan>`.

See the [demo skill](../plugins/dg/skills/demo/SKILL.md),
[TourScript authoring guide](../plugins/dg/skills/demo/references/authoring.md),
and [prototype skill](../plugins/dg/skills/proto/SKILL.md).

Finished work, which has no variants to pick from, uses
[/dg:verify](verify.md). That page shows before, after, and a prototype target
when one is already running.
