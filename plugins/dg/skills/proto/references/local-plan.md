# Plan walkthrough prototype

Build **one cohesive clickable walkthrough** that covers every workflow in a plan or design seed, navigable from a screen switcher. The user flips through the whole feature end to end and judges whether the workflows **cohere**. The question is not what one page looks like or whether one state machine is right. It is whether the whole system makes sense as a product.

This is the right branch when the input is a **plan that spans several workflows**: a plan file, a `.agents/spec/*` spec, an architecture or design seed, or a prose feature description with several distinct user and system flows. For one page's look, use [local-ui.md](local-ui.md). For one state model, use [local-logic.md](local-logic.md).

## When this is the right shape

- "Prototype this plan." "Show me all the workflows." "Walk me through the feature."
- A design seed describes three or more distinct flows (author a thing, see it in a list, a daemon processes it) and the open question is whether they hang together.
- The user wants to feel the feature across screens before it is specced or built, not pick between layouts of one screen.

## Relationship to the other branches

A walkthrough is a **container of screens**. A screen can borrow either other shape.

- A screen that is really a state machine can embed a small logic-style interactive.
- A screen whose look is genuinely open can offer inline `?variant=` swatches. That is the exception. The walkthrough's job is breadth (every workflow), not depth (one page's variants). Do not turn it into a variants prototype with extra tabs.

## Process

### 0. Pick the location

Plan walkthroughs **always** live in `.agents/prototype/<name>/`, even when throwaway and even under `--light`. The walkthrough is a durable reference while the plan is specced. On first use of `.agents/prototype/` in a project, make sure it is gitignored, and commit that line on its own.

**Rendering, framework-aware default**

- **The host app is a JS framework** (Next, Vite, Astro): mount the walkthrough on a real route (sub-shape A in [local-ui.md](local-ui.md)) so screens butt up against the real header, sidebar, and density. The screen switcher replaces the variant bar.
- **The host app is not a JS framework** (.NET, Python, Go, a library, a docs repo): write a **single self-contained HTML file** in `.agents/prototype/<name>/` (inline CSS and JS, no build step), served by `prototype serve`.
- **`--self-contained`**: force the single file whatever the host stack.

Open the walkthrough the moment it is ready. `~/.dg/bin/dg-skills prototype serve` prints the URL, and `~/.dg/bin/dg-skills prototype open <url-or-file>` opens it in the default browser. Do not make the user open it by hand.

### 1. Inventory the workflows from the plan

Read the plan and extract the **distinct workflows**. Each becomes one screen. Do not invent them. Pull them from the plan's structure: its phases, slices, headings, and the actors it names. Write the inventory into `NOTES.md` as one line per screen before building, so coverage is checkable.

A typical inventory is the authoring flow, the list or coexistence view, the processing or execution view, and a short "how it maps to code" reference screen. Cap it at what the plan contains: one screen per real workflow, no padding.

### 2. Build the walkthrough shell

One artifact with a **screen switcher**:

- A persistent left nav (or top tabs) lists every workflow screen, grouped (for example "Workflows" and "Reference").
- Screens are sections toggled by the switcher. One shows at a time.
- `Left` and `Right` arrow keys cycle screens, except while an input, textarea, or `[contenteditable]` has focus.
- For a JS-host route, drive the switch through the router or a `?screen=` parameter so it is shareable and reload-stable. For self-contained HTML, plain JS state is fine.
- **Nav DOM contract (self-contained HTML).** Each nav item is a `[data-go="<screenId>"]` element, and each screen section is `#s-<screenId>` (for example `data-go="list"` and `#s-list`). The script that `prototype serve` injects targets `[data-go]` to badge changed screens (step 4). Keep this convention even when the walkthrough's own switcher is hand-rolled.

### 3. Give each screen real fidelity

Each screen should feel like the real product moment, with **plausible seed data**: real-looking names, statuses, and the plan's actual domain vocabulary. Make the load-bearing interaction actually interactive. The create flow lets you fill the form and see the resulting record. The execution view animates the run and shows success or failure per item. Static mockups hide exactly the coherence problems a walkthrough exists to surface. Match the project's styling system when mounting in the app. Otherwise use a clean, consistent self-contained theme.

Include a short **"how it maps to code"** reference screen: each workflow and the real files and seams it lands on, taken from the plan. It makes the walkthrough useful to the spec that follows.

### 4. The switcher, per-screen notes, and the decision gate

Reuse the shared switcher where the project has one (see `~/.dg/bin/dg-skills prototype components`). For self-contained HTML, a small fixed nav is fine. A plan walkthrough replaces the variant picker with a **review-and-decide** control:

- **Per-screen notes.** Every workflow screen carries a notes textarea, keyed by screen id. The user jots reactions in context: "this step is wrong", "needs a test-run button", "reorder these". Show a count ("2 screens noted") and mark noted screens in the nav.
- **A fixed decision bar** with two buttons: **Approve design** and **Decline and rework**. There are no N variants to choose between. The decision is about the whole plan.
- **On Approve**, compile a handoff (the decision and every screen's notes) and continue to `/dg:prd` with the notes folded in.
- **On Decline**, compile the same handoff and revise the walkthrough against the notes, reopen it, and ask again. Do not continue to `/dg:prd` until approved.

**The decision reaches the agent automatically through the local server.** Serve the walkthrough so Approve and Decline POST straight back:

```sh
~/.dg/bin/dg-skills prototype serve .agents/prototype/<name>/walkthrough.html <name> &
~/.dg/bin/dg-skills prototype open http://127.0.0.1:<port>/
~/.dg/bin/dg-skills prototype await-decision <name> --json
```

The server prints its URL, and it moves to the next free port when 4321 is taken. `await-decision` blocks and prints `{"decision":"APPROVED|REWORK","notes":"..."}`. Run `serve` and `await-decision` from the same directory.

Wire Approve and Decline to the injected `window.prototypePlanDecision(decision, notes)`. Do not hand-roll `fetch("POST /prototype-decision")` in the walkthrough. The helper posts the decision, then shows the shared full-screen overlay (state pill and a reload-aware subtitle), so Decline gives visible confirmation. Disable both buttons on click so a pending decision cannot be sent twice. The server writes the `.decision` file, and `await-decision` unblocks. Then branch:

- **APPROVED**: run `/dg:prd` with the notes.
- **REWORK**: revise `walkthrough.html`, **write a `.changes` manifest** so the user sees what moved, bump the reload token so the open tab refreshes, and arm `await-decision` again:

  ```sh
  TOKEN=$(date +%s)
  cat > "$(~/.dg/bin/dg-skills prototype changes-path <name>)" <<JSON
  {"rev":"$TOKEN","summary":"Reworked per your notes","screens":[{"id":"list","note":"added draft row and status tabs"}]}
  JSON
  echo "$TOKEN" > "$(~/.dg/bin/dg-skills prototype reload-path <name>)"
  ```

  Write `.changes` first so `rev` is ready when the client re-fetches. The served page polls `/prototype-reload` every 2 seconds and reloads when the token changes.

**The `.changes` manifest** shows the diff across a rework cycle without hunting through screens:

- `rev` **must equal** the reload token you are about to write. The client shows the manifest only when `rev` matches the current token, so a stale one from a killed agent is harmless.
- `screens[].id` must match a real `data-go` and `#s-<id>` pair. The client badges those nav items with a dot and lets the user click straight to the changed screen from the summary pill.
- `summary` is optional free text for the panel heading.
- It is additive and optional. Without a manifest there is no pill and no dots.
- `~/.dg/bin/dg-skills prototype changes-path <name> [--light]` prints the sidecar path, like `reload-path`.

The tab favicon shows the state: waiting for the decision, reworking after Decline, or approved.

**Fallback with no server (opened as `file://`).** The page's `detectServer()` finds no endpoint, and the buttons fall back to a copy-paste overlay. The user copies the compiled decision and notes block into the chat. The agent branches the same way.

In production builds, gate the bar and notes off.

**Stale decision caution.** `.decision` is a plain file-existence check with no session nonce. If a prior run posted a decision that was never consumed, the next `await-decision` returns it at once. Before arming again after a restart, check for a leftover `.decision` or `.reject` with `prototype decision-path <name>` and clear it instead of trusting the first read.

### 5. Capture the plan-to-screen map and the answer

In `.agents/prototype/<name>/NOTES.md`:

- The **question** the walkthrough answers: does this plan cohere end to end?
- The **screen inventory** (workflow to screen), so coverage is auditable.
- The **screen-to-code map**, a mirror of the reference screen.
- An **Answer** placeholder. Fill in what the walkthrough taught: which workflow is load-bearing, which transitions felt wrong, and what to change in the plan or spec.

### 6. Hand it over and branch on the decision

Give the user the open command (or the route and `?screen=` keys). Await the decision with `await-decision` on a served page, or through the pasted-back handoff block on `file://`. Then:

- **APPROVED**: fold the per-screen notes into the plan or spec and run `/dg:prd` (or `/dg:spec`). The notes are now requirements. Weave them in, do not drop them.
- **REWORK**: revise the walkthrough against the notes (reorder screens, fix the flagged interaction, add the missing affordance), reopen it, and ask again until approved. Record each round's notes in `NOTES.md` so the rework history is not lost.

The interesting feedback is "workflow B should come before A" or "the list needs to show X from the create step". Those are flaws in the plan, which is the point.

### 7. Capture the answer and clean up

Once approved and folded into the plan or spec, leave the walkthrough in `.agents/prototype/<name>/` with the answer and final notes filled in, as a reference until the feature ships. Then delete it. Do not promote walkthrough code to production.

## Anti-patterns

- **Padding the screen count.** One screen per real workflow in the plan. Screens the plan does not describe are noise.
- **Static mockups.** If the load-bearing interaction does not run, the coherence question goes unanswered. Make at least the create flow and the execution view interactive.
- **Turning it into a variants prototype.** The walkthrough is breadth across workflows, not N layouts of one page. For layouts, use [local-ui.md](local-ui.md).
- **Stranding it in scratch.** Walkthroughs live in `.agents/prototype/<name>/` so they survive while the plan is specced. `--light` does not move a walkthrough out of `.agents/`.
- **Wiring to real mutations.** Keep it read-only and in memory. The question is whether the workflows cohere, not whether the backend works.
