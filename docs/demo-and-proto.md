# Guided tours and live-page prototypes

Play a **live guided tour** of a feature in your real browser — the extension
spotlights each element and injects explanatory text boxes, step by step:

```text
Claude Code: /dg:demo 1517
Codex:      $dg:demo 1517
```

You review the compiled tour script before it plays. Optional screenshots/video
land in your Downloads folder.

Tours can include a setup phase for login, configuration, or seeded data. Setup
is excluded from the tutorial and recording by default, but can be explicitly
included as the opening steps.

Explore app-native UI approaches directly inside a live page, then export the
one you approve:

```text
Claude Code: /dg:proto
Codex:      $dg:proto
```

The workflow asks for a page and design question, samples the page's visual
styles, presents the proposed comparison, and plants the approved set in the
browser. Run the browser skill's `install` command first to load the companion
extension. For authenticated or private pages, review the privacy warning
before allowing the style scrape. The CLI writes approved answers under
`.agents/prototype/<slug>/` and removes temporary Downloads and scratch files
after export.

See the [demo skill](../plugins/dg/skills/demo/SKILL.md),
[TourScript authoring guide](../plugins/dg/skills/demo/references/authoring.md),
and [prototype skill](../plugins/dg/skills/proto/SKILL.md).
