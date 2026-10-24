# Extension mode (`--ext`)

Run a standalone, throwaway workflow: scrape the page's visual language, generate
variations, let the user choose in the real page, export the approved answer, and
remove temporary artifacts.

Read [commands.md](commands.md) before invoking the CLI.
Read [contracts.md](contracts.md) before authoring a plan.

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

Default to 5 variations. Accept a requested count from 1 through 5;
never exceed the maximum of 5 — the plan travels in the planted page's URL
marker, and 5 variations is the largest comparison that marker can carry.
`-n <count>` sets that count. `-o "<a>,<b>"` names the directions: build exactly one
variation per name, in order, and use each name as its `label`. `-o` overrides `-n`
and lists at most 5 names. The flags `--light`, `--self-contained`, `--series`,
`--publish` and `-c` belong to the local mode and are ignored here.

## Phase 2 — Scrape

Check this skill's extension-install precondition before opening the page, then
initialize the correct dev or installed CLI and run `proto --ext scrape`. Follow the
commands and timeout recovery in the command reference.

Read the returned `style-guide.json`. The slug is the name of its parent
directory and remains stable for this entire session.

## Phase 3 — Generate

Generate the requested number of variations as one `ProtoPlan`.

- Reuse StyleGuide color, type, spacing, radius, shadow, custom-property, and
  sampled-component tokens verbatim so every option looks native to the app.
- For any form control (radio, checkbox, text input, select, textarea, button),
  copy the exact classes from the StyleGuide's `controls` array and the
  matching entry in `components` (for example Bootstrap's `form-check`,
  `form-check-input`, `form-control`, `form-select`, `btn btn-primary`) onto
  the real native element. A plain unstyled `<input>`/`<select>` renders
  invisible or broken on a Bootstrap-themed page; reusing the host's own
  classes is what makes it look and behave native. Respect the StyleGuide's
  `meta.colorScheme` (and any `data-bs-theme`/`data-theme` it names) so a dark
  variation does not plant light-only markup on a dark page.
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

From the target project root, run `proto --ext plant` with the approved scratch plan.
The command blocks while the extension plants the choices and the user cycles,
selects, and approves or rejects them. The picker also offers a "Show original"
toggle so the user can compare each variation against the real, unmodified
element before deciding — this is expected and is not a stall.

Do not infer a result from browser state or elapsed time.

**No self-test convention here.** Local mode's `--selftest`/`.source`/`--require-pending`
(see [local-build.md](local-build.md)) exist because a decision-bar self-test and the user's
real click write to the same kind of file, asynchronously, with no built-in ownership check.
`plant` has no equivalent risk: one `plant` invocation is one synchronous browser session that
blocks until a human clicks something in it, there is no background process that could write a
verdict on the agent's behalf, and a verdict a human did not produce in that same browser session
never reaches `proto --ext plant`'s stdout.

## Phase 6 — Claim verdict and run the refine chain

Claim only the command's returned result. The first line of the output names the
verdict.

`approve <key>` with no notes ends the chain. `approve <key>: <note>` makes that
variation the base of a new round. `tweak <key>: <note>` edits that variation in
place in the current round. Reject reworks the same round. The chain also ends
when the user says "done" or "stop".

```text
Reject
  -> read and incorporate the returned feedback
  -> regenerate the plan at the same path with the same slug
  -> re-present the comparison for approval
  -> re-plant the same slug (the CLI clears the stale verdict first)

Tweak (output starts "Prototype tweak requested (refine):")
  -> apply the notes to that variation in place; change only what the notes ask
  -> build no new variations and start no new round
  -> re-present it and re-plant the same plan for a pick

Approve with notes (output starts "Prototype approved with notes (refine):")
  -> the CLI exported this round and recorded it in NOTES.md
  -> copy the selected variation's html and css as the base
  -> build the same number of new variations; change only what the notes ask
     and keep everything else in the base exactly as it is
  -> reuse the same slug and the original StyleGuide tokens
  -> re-present the comparison for approval, then re-plant the same slug
  -> claim the fresh verdict again

Approve without notes (output is the answer path)
  -> the chain ends; go to Phase 7
```

Never change the slug to escape a rejection or to start a round. Keep reusing the
original StyleGuide tokens. Do not apply "structurally different" to the parts
of a refine round that the notes leave alone. Do not run cleanup until an approve
with no notes.

## Phase 7 — Export and Cleanup

On Approve with no notes, `proto --ext plant` exports the winning self-contained
`index.html`, editable `styles.css`, optional completed `preview.png`,
`lineage.md`, and `NOTES.md` marker under `.agents/prototype/<slug>/`, then
prints the answer path. Approve with notes exports the same files for that
round, so the latest pick always exists on disk, but the chain stays open.

`lineage.md` keeps one `## round-N` block per round with its base, variants,
pick, note, tweaks, and status — the same file and format the local mode
writes (see [local-ui.md](local-ui.md) §5.5 and [contracts.md](contracts.md)).
While the last round is `open`, a new plant of the same slug and question
continues the chain. Once a round is `done`, it starts fresh. `NOTES.md` keeps
the question, the latest `Verdict` JSON, and the editing note; it carries no
round history of its own.

Verify the answer and its `NOTES.md` marker before cleanup. Run `proto --ext cleanup`
from the same target project root to remove only the stable scratch artifacts
for that slug. Preserve the exported answer and report its path to the user.
