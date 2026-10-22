---
name: proto
description: Build a throwaway prototype before committing to a design. Routes to a runnable terminal app (state/logic questions), UI variations toggleable from one route (five by default, set with -n, or named with -o), or a clickable walkthrough across a plan's workflows — all local by default. Pass --ext to compare UI variations directly on a live, already-running page via the dg-ai-extension instead, with no source edit and no dev server. Use when the user wants to prototype, sanity-check a data model or state machine, mock up a UI, explore design options, or compare variants on a real live page, or says "prototype this", "show me all the workflows", "let me play with it".
---

# /dg:proto — Throwaway Prototype

A prototype is **throwaway code that answers a question**. The question decides the shape.

Default: prototype **locally** (TUI, UI variants, or a plan walkthrough — see "Pick a branch" below). Pass **`--ext`** to prototype directly on a live, already-running page instead, via the dg-ai-extension — see "## --ext" at the bottom.

Read [references/commands.md](references/commands.md) before invoking the `--ext` CLI. Read [references/contracts.md](references/contracts.md) before authoring an `--ext` plan or a local manifest.

## Flags

| Flag | Short | Effect | Default |
|---|---|---|---|
| `--ext` | none | Prototype directly on a live, already-running page via the dg-ai-extension, instead of the local flow below | off (local) |
| `--count <count>` | `-n` | Number of UI variants to build. Local: any count of 1 or more. `--ext`: 1 through 5 | 5 (`--ext`: 3) |
| `--options "<a>,<b>"` | `-o` | Comma-separated directions to build. One variant per name, exactly those, no extras. Overrides `--count` | none |
| `--light` | none | Put the sandbox in scratch (`$(~/.dg/bin/dg-skills prototype dir <name> --light)/`), wiped on reboot | off (durable sandbox) |
| `--publish` | none | Publish the winning variant as an Artifact after the pick | off |
| `--self-contained` | none | Render one inline HTML file, no dev server | off |
| `--continue [<name>]` | `-c` | Resume an open refine chain: list open chains, or load the named one and start its next round | off |

`-n` and `-o` apply to the UI-variants branch (local or `--ext`). Logic and plan branches ignore them.
If `-n` and `-o` disagree, `-o` wins. Local `-n` has no upper limit; `--ext` caps at 5. `-c` and the
refine chain apply to the local UI-variants branch only — `--ext` has no refine chain.

**Usage:** `/dg:proto [what you want to explore] [-n <count>] [-o "<a>,<b>"] [--light] [--publish] [--self-contained] [-c [<name>]] [--ext]`

## Rendering — local-first, ALWAYS (no runtime external CDN)

A prototype that doesn't render is worthless. The #1 failure mode is a page that pulls a
library from an external CDN (`unpkg`, `jsdelivr`, Google Fonts, etc.) at runtime — it renders
blank the moment the network is blocked, offline, or slow. **Never `<script src>`/`<link href>`
an external URL in a prototype.**

**Hard rule — a prototype of an existing app's UI renders IN that app.** When the thing being
prototyped is a page, panel, dialog, or component of a web app in the repo, mount the variants in
the real running app (ui.md sub-shape A). Never rebuild the app's chrome as a standalone
look-alike page: hand-copied colors, fonts, and layout never match, and the user judges the copy
instead of the design. The order below applies only when there is no app to host the prototype,
or when the user passed `--self-contained`. The two usual blockers have fixed answers in ui.md
§"When the app is hard to run" (busy worktree, no backend, auth). A blocker is never a reason to
fall back to a standalone page.

Order of preference for rendering a visual prototype that has no host app:

1. **Render it as self-contained HTML, served locally by `dg-skills prototype`.** For the
   UI-variants branch, build the manifest and run `dg-skills prototype ui` (see
   `references/ui-generate.md`) — it renders, serves, and opens in one call. For a plan
   walkthrough or a hand-wired page, run `dg-skills prototype serve` directly (see
   `references/plan.md`, `references/ui.md`). The served page is the local renderer now —
   themed, session-namespaced by the prototype's name, and auto-opened; there is no `/viz` hop.
2. **Vendor a dependency the renderer can't express natively** (e.g. Teams AdaptiveCards, a
   canvas/WebGL widget) by downloading it into the prototype dir and referencing it by relative
   path — never a remote URL. Better still, hand-render to plain HTML/CSS so there is no JS
   dependency at all.
3. **Verify it renders before handing it to the user.** Load the page (Playwright MCP if
   available; else a Node/headless check that the expected DOM/HTML is produced) and confirm the
   real content is present — do not hand over an unverified page and ask the user if it "looks
   right."

## Routing

| Task | Read |
|---|---|
| Sandbox location, `--light` / `--self-contained` flags, and behavioral rules | `references/build.md` |
| Variant count (`-n`) and named options (`-o`) | `references/ui.md` §1 |
| Building state/logic prototype (TUI) | `references/logic.md` |
| Building UI variants prototype | `references/ui.md` |
| Zero-ceremony manifest authoring for `dg-skills prototype ui` | `references/ui-generate.md` |
| Building a plan / multi-workflow walkthrough | `references/plan.md` |
| Resuming a UI prototype whose pick may already be made (dead/backgrounded waiter, resumed or compacted session) | `references/ui.md` §5 |
| `--publish` flag | `references/build.md` |
| Refine chain (`approve` with a note, `tweak`) and `--continue` | `references/ui.md` §5.5 |
| `--ext`: live-page extension-assisted CLI and recovery | `references/commands.md` |
| `--ext`: StyleGuide / ProtoPlan / Verdict JSON contracts | `references/contracts.md` |

## Pick a branch

Identify which question is being answered — from the user's prompt, the surrounding code, or by asking if the user is around:

- **"Does this logic / state model feel right?"** → [references/logic.md](references/logic.md). Build a tiny interactive terminal app that pushes the state machine through cases that are hard to reason about on paper.
- **"What should this look like?"** → [references/ui.md](references/ui.md). Generate several radically different UI variations on a single route, switchable via a URL search param and a floating bottom bar.
- **"Does this whole plan hang together?" / "show me all the workflows"** → [references/plan.md](references/plan.md). The input is a *plan or design-seed spanning multiple workflows* (e.g. a `~/.claude/plans/*.md` file, a `.agents/spec/` bundle, or a prose feature design). Build **one** cohesive clickable walkthrough with a screen-switcher across *every* workflow — not N variants of one page.
- **"Compare these directly on the live page, don't touch source"** → pass `--ext`. Same UI-variants question as above, but answered by scraping the deployed page's own style tokens through the dg-ai-extension and injecting variants into its real DOM, instead of mounting in project source. Use this when there's no dev server to mount into, the page is someone else's deployed app, or the user explicitly wants to judge it in production chrome. See "## --ext" below.

The branches produce very different artifacts — getting this wrong wastes the whole prototype. Tells: a single state machine or data model → logic; one page or component whose *look* is in question → ui (local by default, `--ext` when it must happen on the live page itself); a multi-workflow feature/plan where the question is whether the workflows *cohere end-to-end* → plan. If the input names or points at a plan/design-seed file, or asks to "prototype this plan" / "walk me through the feature" / "show all the workflows", that's the plan branch. If genuinely ambiguous and the user isn't reachable, default to whichever branch best matches the input (a backend module → logic; a page → ui; a plan/spec → plan) and state the assumption at the top of the prototype.

## Refine chain

`approve C` with no note ends the prototype. `tweak C: <note>` edits C in place in the current round, builds no new variants, and shows C again for a pick. `approve C: <note>` makes C the base of a new round: `-n` new variants that change only what the note asks. The chain ends on an approval with no note, or on "done" or "stop". Resume a later session with `/dg:proto -c`.

Example, a form and then its buttons:

1. `/dg:proto signup form` builds round 1, variants A to E.
2. `approve C: organize the buttons` builds round 2: five variants of C with only the buttons changed.
3. `approve B: tighten the spacing` builds round 3 from round 2 B.
4. `approve D` ends the chain. `--publish` publishes round 3 D only.

Details: `references/ui.md` §5.5. The refine chain is local-only; `--ext` has no equivalent.

## When done

The _answer_ is the only thing worth keeping from a prototype. Capture it somewhere durable (commit message, ADR, issue, or a `NOTES.md` next to the prototype) along with the question it was answering. If the user is around, that capture is a quick conversation; if not, leave the placeholder so they (or you, on the next pass) can fill in the verdict before deleting the prototype.

**Returning to a prototype rather than building one?** A UI prototype's pick may already be sitting unclaimed — see Routing above (`references/ui.md` §5) before assuming the verdict was lost or re-prompting.

## When a prototype feeds a planning document

If the prototype's outcome is referenced by a planning document (a `/spec` spec, a `~/.claude/plans/*.md` plan, a `/prd` deliverable), it stops being throwaway for the life of that plan and becomes the **source of truth for the design and feature set** it settled. Three rules apply:

1. **Keep the asset available.** The prototype must live in the durable `$(~/.dg/bin/dg-skills prototype dir <name>)/` location — **never only in the `--light` `/tmp` sandbox**, which is wiped on reboot while the plan is still open. If it was built `--light`, promote it into `$(~/.dg/bin/dg-skills prototype dir <name>)/` before referencing it. Record its path (and the winning `?variant=` key, if a UI-variant prototype) in the planning document so downstream agents can open it.
2. **Follow it completely.** Agents implementing a prototyped decision must reproduce the referenced prototype's design and feature set faithfully — it is the settled answer, not a loose suggestion. Do not silently drop features or re-decide look/flow the prototype already resolved.
3. **Ask when it doesn't fit the code.** Where the prototype conflicts with the current code design (data shape, existing components, framework constraints it couldn't see), the agent must surface the mismatch rather than silently diverging or force-fitting it — as a direct question if interactive (discovery/roundtable), or as an escalation the orchestrator relays if inside a workflow that forbids interactive prompts.

## --ext — live-page, extension-assisted (dg-ai-extension)

Pass `--ext` to prototype variants directly on a live, already-running page via the
dg-ai-extension, instead of the local flow above: scrape the page's visual language, generate
variations, let the user choose in the real page, export the approved answer, and remove
temporary artifacts. The flow below is otherwise standalone and throwaway, same as the local
branches.

### Operating rules

- Run plant and cleanup from the target project root. This determines where the
  durable `.agents/prototype/<slug>/` answer is written.
- Treat authenticated, private, admin, and customer pages as sensitive. Warn
  that scraping inspects rendered DOM and computed styles, then obtain explicit
  confirmation before opening the scrape URL.
- Keep the prototype throwaway. Do not edit application source unless the user
  separately asks to implement the approved result.

### Phase 1 — Understand

Confirm the live HTTP(S) URL, the design question, the intended mount area, and
the target project root. `mountSelector` is optional: when no stable CSS
selector is available, omit it and let the in-browser region picker choose the
mount area. Use `replace` mode unless the user explicitly requests a full-page
takeover.

Default to 3 variations. Accept a requested count from 1 through 5;
never exceed the maximum of 5.

### Phase 2 — Scrape

Check this skill's extension-install precondition before opening the page, then
initialize the correct dev or installed CLI and run `proto scrape`. Follow the
commands and timeout recovery in the command reference.

Read the returned `style-guide.json`. The slug is the name of its parent
directory and remains stable for this entire session.

### Phase 3 — Generate

Generate the requested number of variations as one `ProtoPlan`.

- Reuse StyleGuide color, type, spacing, radius, shadow, custom-property, and
  sampled-component tokens verbatim so every option looks native to the app.
- Make variations structurally different, not merely recolored. Vary layout,
  information hierarchy, and the primary affordance.
- Keep markup self-contained and compact. Do not add scripts, event handlers,
  remote assets, or external stylesheets.
- Preserve the same slug during every rework.

Write the plan to `/tmp/ai/proto/<slug>/plan.json`.

### Phase 4 — Approval gate

Present a compact table with each variation's key, label, structural thesis,
hierarchy, and primary affordance. Wait for explicit approval of the comparison
set before planting it. Revise and re-present when requested.

### Phase 5 — Plant

From the target project root, run `proto plant` with the approved scratch plan.
The command blocks while the extension plants the choices and the user cycles,
selects, and approves or rejects them.

Do not infer a result from browser state or elapsed time.

### Phase 6 — Claim verdict and run the reject loop

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

### Phase 7 — Export and Cleanup

On Approve, `proto plant` exports the winning self-contained `index.html`,
editable `styles.css`, optional completed `preview.png`, and `NOTES.md` marker
under `.agents/prototype/<slug>/`, then prints the answer path.

Verify the answer and its `NOTES.md` marker before cleanup. Run `proto cleanup`
from the same target project root to remove only Downloads and stable scratch
artifacts. Preserve the exported answer and report its path to the user.

## Credit

The local branches are adapted from [mattpocock/skills `engineering/prototype`](https://github.com/mattpocock/skills/tree/main/skills/engineering/prototype).
