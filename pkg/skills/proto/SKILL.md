---
name: proto
description: Prototype and compare structurally distinct, app-native variations inside a live application page with the dg-ai-extension. Use when a user wants to explore, review, approve, or rework UI alternatives against a real page before implementing one.
---

# Live-page prototype

Run a standalone, throwaway workflow: scrape the page's visual language, generate
variations, let the user choose in the real page, export the approved answer, and
remove temporary artifacts.

Read [references/commands.md](references/commands.md) before invoking the CLI.
Read [references/contracts.md](references/contracts.md) before authoring a plan.

## Operating rules

- Run plant and cleanup from the target project root. This determines where the
  durable `.agents/prototype/<slug>/` answer is written.
- Treat authenticated, private, admin, and customer pages as sensitive. Warn
  that scraping inspects rendered DOM and computed styles, then obtain explicit
  confirmation before opening the scrape URL.
- Keep the prototype throwaway. Do not edit application source unless the user
  separately asks to implement the approved result.

## Phase 1 — Understand

Confirm the live HTTP(S) URL, the design question, the intended mount area, and
the target project root. `mountSelector` is optional: when no stable CSS
selector is available, omit it and let the in-browser region picker choose the
mount area. Use `replace` mode unless the user explicitly requests a full-page
takeover.

Default to 3 variations. Accept a requested count from 1 through 5;
never exceed the maximum of 5.

## Phase 2 — Scrape

Check this skill's extension-install precondition before opening the page, then
initialize the correct dev or installed CLI and run `proto scrape`. Follow the
commands and timeout recovery in the command reference.

Read the returned `style-guide.json`. The slug is the name of its parent
directory and remains stable for this entire session.

## Phase 3 — Generate

Generate the requested number of variations as one `ProtoPlan`.

- Reuse StyleGuide color, type, spacing, radius, shadow, custom-property, and
  sampled-component tokens verbatim so every option looks native to the app.
- Make variations structurally different, not merely recolored. Vary layout,
  information hierarchy, and the primary affordance.
- Keep markup self-contained and compact. Do not add scripts, event handlers,
  remote assets, or external stylesheets.
- Preserve the same slug during every rework.

Write the plan to `/tmp/ai/proto/<slug>/plan.json`.

## Phase 4 — Approval gate

Present a compact table with each variation's key, label, structural thesis,
hierarchy, and primary affordance. Wait for explicit approval of the comparison
set before planting it. Revise and re-present when requested.

## Phase 5 — Plant

From the target project root, run `proto plant` with the approved scratch plan.
The command blocks while the extension plants the choices and the user cycles,
selects, and approves or rejects them.

Do not infer a result from browser state or elapsed time.

## Phase 6 — Claim verdict and run the reject loop

Claim only the command's returned result.

```text
Reject
  -> read and incorporate the returned feedback
  -> regenerate the plan at the same path with the same slug
  -> re-present the comparison for approval
  -> re-plant the same slug (the CLI clears the stale verdict first)
  -> claim the fresh verdict again
  -> Reject loops here; Approve exits the loop
```

Never change the slug to escape a rejection. Keep reusing the original
StyleGuide tokens and maintain meaningful structural differences.

## Phase 7 — Export and Cleanup

On Approve, `proto plant` exports the winning self-contained `index.html`,
editable `styles.css`, optional completed `preview.png`, and `NOTES.md` marker
under `.agents/prototype/<slug>/`, then prints the answer path.

Verify the answer and its `NOTES.md` marker before cleanup. Run `proto cleanup`
from the same target project root to remove only Downloads and stable scratch
artifacts. Preserve the exported answer and report its path to the user.
