# Plan Walkthrough Prototype

Build **one cohesive clickable walkthrough** that covers *every workflow* in a plan or design-seed, navigable from a screen-switcher. The user flips through the whole feature end-to-end and judges whether the workflows **cohere** — not what one page looks like, not whether one state machine is right, but whether the *system* makes sense as a product.

This is the right branch when the input is a **plan spanning multiple workflows**: a `~/.claude/plans/*.md` file, a `.agents/spec/*` spec, an arch/design seed, or a prose feature description with several distinct user/system flows. If the question is about a single page's look → [ui.md](ui.md); about a single state model → [logic.md](logic.md).

## When this is the right shape

- "Prototype this plan." / "Show me all the workflows." / "Walk me through the feature."
- A design seed describes 3+ distinct flows (e.g. author a thing → it appears in a list → a daemon processes it) and the open question is whether they hang together.
- The user wants to *feel* the feature before it's specced/built, across screens, not pick between layouts of one screen.
- The plan is typically a `/dg:spec` bundle (`.agents/spec/<NNN>_<slug>/`), a `~/.claude/plans/*.md`, or design prose.

## Relationship to the other branches

A walkthrough is a **container of screens**; an individual screen can borrow either other shape:
- A screen that's really a state machine can embed a small logic-style interactive (drive it, watch state).
- A screen whose *look* is genuinely open can offer inline `?variant=` swatches — but that's the exception. The walkthrough's job is breadth (all workflows), not depth (one page's variants). Don't turn it into a variants prototype with extra tabs.

## Process

### 0. Pick the location

Plan walkthroughs **always** live in `$(~/.dg/bin/dg-skills prototype dir <name>)/` — even when throwaway, even under `--light` (the walkthrough is a durable reference while a plan is being specced; don't strand it in `/tmp`). On first use of `.agents/prototype/` in a project, ensure it's gitignored before writing into it (add `.agents/prototype/` to the repo's `.gitignore` or a nested `.agents/.gitignore`); commit that gitignore line on its own.

**Rendering — framework-aware default:**
- **Host app is a JS framework** (Next/Vite/Astro/etc.) → mount the walkthrough on a real route (sub-shape A from [ui.md](ui.md)), so screens butt up against the real header/sidebar/density. The screen-switcher replaces the variant bar.
- **Host app is not a JS framework** (.NET/Razor, Python, Go, a library, a docs repo, …) → a **single self-contained HTML file** in `$(~/.dg/bin/dg-skills prototype dir <name>)/` (inline CSS/JS, no build step), opened locally.
- **`--self-contained`** → force the single self-contained HTML file regardless of host stack. Use when the user wants something that opens with zero tooling, or to share the file directly.

Auto-open the walkthrough the moment it's ready — `~/.dg/bin/dg-skills prototype open $(~/.dg/bin/dg-skills prototype dir <name>)/<file>.html` (WSL-aware; opens the default Windows browser). Don't make the user open it by hand.

### 1. Inventory the workflows from the plan

Read the plan/seed and extract the **distinct workflows** — each becomes one screen. Don't invent; pull them from the plan's own structure (phases, slices, headings, the user/system actors it names). Write the inventory into `$(~/.dg/bin/dg-skills prototype dir <name>)/NOTES.md` (see step 5) as a one-line-per-screen list before building, so coverage is checkable.

A typical inventory: the authoring/creation flow, the list/coexistence view, the processing/execution view, and a short "how it maps to code" reference screen. Cap at what the plan actually contains — a screen per real workflow, not padding.

### 2. Build the walkthrough shell

One artifact, a **screen-switcher**:
- A persistent left nav (or top tabs) listing every workflow screen, grouped (e.g. "Workflows" / "Reference").
- Screens are sections toggled by the switcher; only one shows at a time.
- `←` / `→` arrow keys cycle screens (don't intercept when an `<input>`/`<textarea>`/`[contenteditable]` is focused).
- For a JS-host route, drive the switch via the router/`?screen=` param so it's shareable and reload-stable; for self-contained HTML, plain JS state is fine.
- **Nav DOM contract (self-contained HTML):** each nav item is a `[data-go="<screenId>"]` element, and each screen section is `#s-<screenId>` (e.g. `data-go="list"` ↔ `#s-list`). `dg-skills prototype serve`'s injected script targets `[data-go]` to badge changed screens (step 4) — keep this convention even if the walkthrough's own switcher logic is hand-rolled.

### 3. Give each screen real fidelity

Each screen should feel like the real product moment, with **plausible seed data** (real-looking names, statuses, the actual domain vocabulary from the plan). Make the load-bearing interaction *actually interactive* — the create flow should let you fill the form and see the resulting record; the execution view should animate the run and show success/failure per item. Static mockups hide exactly the coherence problems a walkthrough exists to surface. Match the project's styling system if mounting in-app; otherwise a clean, consistent self-contained theme.

Include a short **"how it maps to code"** reference screen: each workflow → the real files/seams it lands on (from the plan). This is what makes the walkthrough useful to the spec that follows.

### 4. The switcher, per-screen notes, and the decision gate

Reuse the shared switcher where the project has one ([ui.md](ui.md) step 4 / `dg-skills prototype components`); for self-contained HTML, a small fixed nav is fine. A plan walkthrough replaces the variant-picker with a **review-and-decide** affordance:

- **Per-screen notes.** Every workflow screen carries a notes textarea (state keyed by screen id). The user jots reactions in-context — "this step is wrong", "needs a test-run button", "reorder these". Surface a count ("2 screens noted") so it's clear notes are being captured. Mark noted screens in the nav.
- **A fixed decision bar** with two buttons: **✓ Approve design** and **✗ Decline & rework**. There are no N variants to choose between — the decision is about the *whole plan*.
- **On Approve** → compile a handoff (the decision + every screen's notes) and route to `/dg:prd`: proceed to spec, folding the notes into it.
- **On Decline** → compile the same handoff and route to a **rework loop**: revise the walkthrough against the notes, reopen, and ask again. Do **not** proceed to `/dg:prd` until approved.

**How the decision reaches the agent — automatic via the local server.** Serve the self-contained walkthrough with `dg-skills prototype serve` so Approve/Decline POST straight back to Claude Code (no copy-paste):

```sh
# 1. serve (background) — auto-picks a free port from 4321
~/.dg/bin/dg-skills prototype serve \
    $(~/.dg/bin/dg-skills prototype dir <name>)/walkthrough.html <name> &
# 2. open the printed http://127.0.0.1:<port>/ URL
~/.dg/bin/dg-skills prototype open http://127.0.0.1:<port>/
# 3. block until the user decides (re-arms the agent loop on each decision)
~/.dg/bin/dg-skills prototype decision wait <name> --json    # → {"decision":"APPROVED|REWORK","notes":"…"}
```

Wire Approve/Decline to the helpers `dg-skills prototype serve` injects — `window.prototypePlanDecision(decision, notes)` — don't hand-roll the `fetch('POST /prototype-decision', ...)` call in the walkthrough's own script. The helper posts the decision, then drives the shared full-screen overlay (state pill + reload-aware subtitle) so Decline gives immediate, visible confirmation instead of an easy-to-miss status-line update. Disable both buttons on click so a pending decision can't be resubmitted while the overlay is up. The server writes the `.decision` file; `decision wait` unblocks and prints it. The agent then branches:
- **APPROVED** → run `/dg:prd` with the notes.
- **REWORK** → revise `walkthrough.html`, **write a `.changes` manifest** so the user can see what moved, then **bump the reload token** so the open tab refreshes itself, and re-arm `decision wait`:
  ```sh
  TOKEN=$(date +%s)
  cat > "$(~/.dg/bin/dg-skills prototype decision changes-path <name>)" <<EOF
  {"rev":"$TOKEN","summary":"Reworked per your notes","screens":[{"id":"list","note":"added draft row + status tabs"},{"id":"step1","note":"disabled Custom SQL card with tooltip"}]}
  EOF
  echo "$TOKEN" > "$(~/.dg/bin/dg-skills prototype decision reload-path <name>)"   # page live-reloads; write .changes FIRST so rev is ready when the client re-fetches
  ```
  (The served page polls `GET /prototype-reload` every 2s and reloads when the token changes — no manual refresh.)

**The `.changes` manifest ("what changed this revision")** is how the user sees the diff across a rework cycle without hunting through screens by hand:
- `rev` **must equal** the reload token you're about to write — the injected client only renders the manifest when `rev` matches the *current* `/prototype-reload` token; a stale or mismatched `rev` is silently ignored (this also makes a leftover `.changes` from a killed agent harmless).
- `screens[].id` must match a real `data-go`/`#s-<id>` pair (see step 2's nav contract) — the client badges those nav items with a small dot and lets the user click straight to the changed screen from the summary pill.
- `summary` is optional free text shown as the panel heading; omit it and the per-screen notes still render.
- This is entirely additive and optional — skip it and the rework loop behaves exactly as before (no manifest → no pill, no dots, nothing to maintain).
- `dg-skills prototype decision changes-path <name> [--light]` prints the sidecar path, mirroring `decision reload-path`.

The served tab's favicon reflects state at a glance: ⏳ waiting for the user's decision, 🔄 reworking (after Decline), ✅ approved.

**Fallback (no server / opened as `file://`):** the page's `detectServer()` finds no endpoint and the buttons fall back to a copy-paste overlay — the user copies the compiled decision+notes block and pastes it into the chat. The agent branches the same way.

In production builds, gate the bar and notes off.

**Stale sentinel caution.** `.decision` is a dumb file-existence check with no session nonce — if a prior run posted a decision that was never consumed (agent killed between the POST and `decision wait` reading it), the next `decision wait` call returns that stale decision instantly. Before re-arming after a restart, check for and clear a leftover `.decision`/`.reject` file with `dg-skills prototype decision path <name>` (or the equivalent sentinel path) rather than trusting the first read.

### 5. Capture the plan→screen map and the answer

In `$(~/.dg/bin/dg-skills prototype dir <name>)/NOTES.md`:
- The **question** the walkthrough answers (does this plan cohere end-to-end?).
- The **screen inventory** (workflow → screen) so coverage is auditable.
- The **screen→code map** (mirror of the reference screen).
- An **Answer** placeholder — fill in what flipping through it taught: which workflow is load-bearing, which transitions felt wrong, what to change in the plan/spec.

### 6. Hand it over and branch on the decision

Give the user the open command (or route + `?screen=` keys). Await the decision — on a dev-server host via `dg-skills prototype decision wait <name>`, on a self-contained host via the pasted-back handoff block (step 4). Then branch:

- **APPROVED** → fold the per-screen notes into the plan/seed and run **`/dg:prd`** (or `/dg:spec`). The notes are now requirements; weave them in, don't drop them.
- **REWORK** → revise the walkthrough against the notes (reorder screens, fix the flagged interaction, add the missing affordance), reopen, and ask again. Loop until approved. Record each round's notes in `NOTES.md` so the rework history isn't lost.

The interesting feedback is **"workflow B should come before A"** or **"the list needs to show X from the create step"** — those are flaws in the *plan*, which is the whole point.

### 7. Capture the answer and clean up

Once approved and folded into the plan/spec, leave the walkthrough in `$(~/.dg/bin/dg-skills prototype dir <name>)/` with the Answer + final notes filled in as a reference until the feature ships, then delete it. Don't promote walkthrough code to production — it was built under prototype constraints.

## Anti-patterns

- **Padding the screen count.** One screen per real workflow in the plan. Inventing screens the plan doesn't describe is noise.
- **Static mockups.** If the load-bearing interaction doesn't actually run, the coherence question goes unanswered. Make at least the create flow and the execution/processing view interactive.
- **Turning it into a variants prototype.** Breadth across workflows, not N layouts of one page. If the user wants to compare layouts, that's [ui.md](ui.md).
- **Stranding it in `/tmp`.** Plan walkthroughs live in `$(~/.dg/bin/dg-skills prototype dir <name>)/` so they survive while the plan is specced. `--light` does not move a plan walkthrough out of `.agents/`.
- **Wiring to real mutations.** Read-only / in-memory. The question is "do these workflows cohere", not "does the backend work".
