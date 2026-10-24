# UI variations

Generate **several radically different UI variations** on one route, switchable from a floating bottom bar. The user flips between variants in the browser, picks one (or steals bits from each), then throws the rest away.

If the question is about logic or state rather than looks, use [local-logic.md](local-logic.md).

## When this is the right shape

- "What should this page look like?"
- "I want a few options for this dashboard before committing."
- "Try a different layout for the settings screen."
- Any time the user would otherwise spend a day picking between vague mockups in their head.

## Two sub-shapes

A UI prototype is much easier to judge when it butts up against the rest of the app: real header, real sidebar, real data, real density. A route on its own is a vacuum where every variant looks fine. Use sub-shape A whenever a plausible host page exists. Use sub-shape B only when the prototype has no nearby home.

**Never substitute a standalone HTML look-alike for an app page.** A manifest or plan served by `prototype ui` is for prototypes with no host app, or for an explicit `--self-contained`. If the prototype is part of a web app in the repo, the variants run inside that app with its real components, styles, and layout. Before handing over, compare a screenshot of the prototype with the real page. If the header, navigation, fonts, or grid differ, it is not mounted in the app and is not done.

### When the app is hard to run

Each blocker has a fixed answer. None of them is a reason to build a standalone page.

- **The app's worktree is busy** (another agent is rebasing or editing it, or it has uncommitted work): create a throwaway detached worktree from the same ref (`git worktree add --detach <path> <ref>`), mount the variants there, and remove it when the prototype is done. Never write prototype files into a worktree another agent owns.
- **No backend or database locally**: point the app's API base URL at a small local mock server (Bun) that serves every endpoint the page calls on load, with fake data and a little latency so loading states show. Keep the mock under `.agents/prototype/<name>/`.
- **Auth blocks the page**: find how the app loads its session (URL tokens, local storage, cookies) and give the mock fake tokens and an admin user. Hand the user one sign-in URL that lands on the page with `?variant=` set.
- **A default port is taken**: pick a free port. Never kill a process you did not start.

### Sub-shape A: adjustment to an existing page (preferred)

The route exists. Variants render **on the same route**, gated by a `?variant=` search parameter. Data fetching, params, and auth stay. Only the rendering swaps. If the prototype is for something that has no page yet but would live inside one (a new section, a new card, a new step in a flow), that is still sub-shape A: mount the variants inside the host page.

### Sub-shape B: a new page (last resort)

Use it only when the thing has no existing page to live in, such as a new top-level surface. Create a throwaway route that follows the project's routing convention. Name it so it is obviously a prototype (the word `prototype` in the path or filename). Use the same `?variant=` pattern. Before choosing B, check that no existing page could host it: an empty route hides design problems a populated one would show.

In both sub-shapes the floating bottom bar is identical.

## Process

### 0. Pick the location

The sandbox is `.agents/prototype/<name>/`, gitignored on first use. Under `--light` it is the scratch directory (see [local-build.md](local-build.md)). Variant components and the switcher that must mount on a real route live in the app's source tree. Everything else (the `NOTES.md`, the plan blurb, screenshots, scratch fixtures) lives in the sandbox. Name in-source variant files with `prototype` in the path and list them in `NOTES.md` so cleanup is trivial.

### 1. State the question and pick N

The default is **5 variants**, keyed `A` to `E`. `-n` raises or lowers that with no upper limit. Keep each variant radically different.

- `-n <count>` or `--count <count>` sets the number (1 or more, keys `A`, `B`, ...; past `Z` use `AA`, `AB`, ...).
- `-o "<a>,<b>"` or `--options "<a>,<b>"` names the directions. Build exactly one variant per name, in the order given, and no others. Use each name as the variant's label. `-o` overrides `-n`.
- Pad nothing. Two names mean two variants.

Write the plan in one line in `NOTES.md`: "Five variants of the settings page, switchable via `?variant=`, on the existing `/settings` route."

### 2. Generate radically different variants

Hold each variant to the page's purpose and data, the project's component library and styling system, and a clear exported component name such as `VariantA`. Variants must be **structurally different**: a different layout, information hierarchy, and primary affordance, not only different colors. Three tweaked card grids is wallpaper. If two drafts come out too similar, redo one with explicit "do not use a card grid" guidance.

### 3. Wire them together

Create one switcher on the route:

```tsx
const variant = searchParams.get("variant") ?? "A";
return (
  <>
    {variant === "A" && <VariantA {...data} />}
    {variant === "B" && <VariantB {...data} />}
    <PrototypeSwitcher variants={["A", "B"]} current={variant} prototypeName="settings" />
  </>
);
```

For sub-shape A, keep the existing data fetching above the switcher and swap only the rendered subtree. For sub-shape B, the throwaway route mounts the same switcher.

### 4. Build the floating switcher

A fixed bar at the bottom center with a left arrow (previous variant, wraps), a label (`B: Sidebar layout`), and a right arrow (next, wraps). Clicking an arrow updates the `?variant=` search parameter through the framework's router so the variant is shareable and reload-stable. `Left` and `Right` keys also cycle, except while an input, textarea, or `[contenteditable]` has focus. The bar must look distinct from the page, and it is hidden in production builds (`process.env.NODE_ENV !== "production"` or the equivalent).

**Use the shared template. Do not write one from scratch.** `~/.dg/bin/dg-skills prototype components` prints the installed template directory. Copy `PrototypeSwitcher.tsx` for React, Next, or Vite, `PrototypeSwitcher.astro` for Astro, or `prototype-decision-bar.html` for a hand-written self-contained page. Pass `labels` (variant key to description) so the bar renders `slug · KEY: description`.

**Every picker ships a light/dark toggle.** All templates carry it: `?mode=light|dark` in the URL plus a `dark` class on `<html>`, light by default. Style the variants against `html.dark` so one toggle themes the prototype too. A reviewer who cannot see both modes approves a variant that breaks in the other one. Never strip the toggle or hardcode one theme.

The bar carries three decision controls to the right of the arrows:

- **Notes** toggles a free-text panel. A marker shows when it is non-empty. Notes ride along with the next button the user clicks.
- **Approve** (green) POSTs `{ name, variant, variants, notes, action: "confirm" }` to `/prototype-confirm`. It closes the tab only when the notes are empty. A noted approval shows the "Selected variant X" overlay and keeps the tab open.
- **Reject** (amber) opens a popup that needs a non-empty note, so a rework always has direction. Quick-pick reason chips are shown (`rejectReasons` tailors them). It POSTs `action: "reject"`, never closes the tab, and shows an inline "Reworking options" banner. The agent revises the variants, bumps the reload token, and the open tab refreshes.

`prototype wait` reports both the action and the notes. The tab favicon shows the state: waiting, processing, or done.

### 4.5 Expose the selection endpoint

For a mounted app, copy the matching endpoint template from the templates directory: `prototype-endpoint.ts` for Node, Vite, Bun, or Express, `prototype-endpoint.next.ts` for Next, or `prototype-endpoint.astro.ts` for Astro. Each is dev-only (keep the `NODE_ENV` guard), checks the variant key against the caller-supplied list, resolves the sentinel path with `~/.dg/bin/dg-skills prototype path <name>`, and writes `variant` plus a newline to it.

A page served by `prototype serve` or `prototype ui` skips this step. The server injects the decision endpoint (`window.prototypeDecide`, `POST /prototype-decision`).

### 5. Hand it over

**Never hand over a prototype whose only affordance is switching variants.** A UI prototype the user must decide on carries the notes box and the **Approve** and **Reject** buttons wired to the sentinel, and the agent then blocks on `prototype wait` before treating it as delivered, or says plainly why it cannot. For a prototype with no host app, use `~/.dg/bin/dg-skills prototype ui <plan|manifest>` (see [local-formats.md](local-formats.md)). It builds the page with the full bar, serves and opens it, blocks for the decision, and prints one JSON line. Do not hand-roll a page with only arrow buttons. For a mounted app route, copy the switcher and endpoint templates. Either way a switcher without Approve, Reject, and notes is incomplete.

**Someone must end up waiting.** A click writes a durable sentinel (see "Claim an outstanding pick" below), but nothing reports it until something calls `wait` or `status` on it. If a builder subagent mounts the prototype and hands off to a different session or the main loop, decide explicitly which side blocks on `prototype wait <name>` — do not hand off assuming the other side already is, or already will. If neither side can block right now, say so and give the exact `prototype wait <name>` (or `status <name>`) command in the handoff, the same way an AFK handoff does below.

**Hand-wire it instead when one document must own every variant**: shared CSS, JS, or state that per-variant fragments cannot express, the usual shape of a motion prototype. Paste `prototype-decision-bar.html` into the page, then run both commands from the same directory every time:

```sh
~/.dg/bin/dg-skills prototype serve <html-file> <name> --port=4321
variant=$(~/.dg/bin/dg-skills prototype wait <name> --timeout=3600 --json)
```

Read the port that `serve` printed. It moves to the next free port, so the one you asked for may not be the one it listens on.

**Open the prototype in the browser as soon as it builds**, then still print the URL and the `?variant=` keys for reopening.

#### Claim an outstanding pick

**The sentinel is durable: a verdict is never lost, only unclaimed.** The browser Approve (or `prototype confirm`) writes `.selection` and `.notes`. Reject writes `.reject`. They outlive the `wait` process, a backgrounded shell, a compacted context, and the session. Both `wait` and `status` check the file before they block, so a click made while nothing listened is still there.

**Re-check on every re-entry to an outstanding prototype**: a backgrounded `wait` that may have died, a session resumed from a handoff note, a compacted context, or a new agent that inherited the work. Do it before relaunching a waiter or reopening the browser, or you ask for a decision the user already made.

For a page that `prototype ui` serves, check and claim with the chain key. `prototype status` from another directory could print `pending` while the decision is stored, but a session chain key avoids that:

```sh
~/.dg/bin/dg-skills prototype status <chain>
~/.dg/bin/dg-skills prototype wait <chain> --timeout=1
```

The second command consumes the decision. Use `prototype status <name>` with no session only for a hand-wired page.

**Do not rely on a live foreground `wait` surviving the session.** If you background it, or hand the prototype off while a pick is outstanding, leave a breadcrumb. Record the prototype name and the literal `~/.dg/bin/dg-skills prototype wait <name>` command both in the handoff note and in `NOTES.md`. A note that only says "awaiting the user's pick" strands the selection.

The selected variant is then available as `$variant` for later steps such as `--publish`. The interesting feedback is usually "the header from B with the sidebar from C".

### 5.5 Refine chain

At the pick step, read the result of `prototype wait <name> --json`:

- `approve <key>` with no notes: the chain ends. Go to step 6. In a series, this approval moves to the next prototype in the same tab instead.
- `approve <key>` with notes: the winner is the base of the next round. Build `-n` new variants from it. Change only what the notes ask. Keep everything else in the base exactly as it is, and do not apply "radically different" to the unchanged parts. Run the next round in the same tab.
- The user types `tweak <key>: <note>`: apply the note to that variant in place in the current round. Build no new variants, start no new round, and do not end the chain. Append the note to the round's `tweaks:` list in `NOTES.md`, bump the reload token, and show the variant again. The viewer has no matching action, so `tweak` is a typed verb only.
- The user says "done" or "stop": the chain ends with the last picked variant. Run `~/.dg/bin/dg-skills prototype stop <chain>`, then go to step 6.
- Reject: rework the same round.

**Same tab across rounds.** With `prototype ui`, one chain is one server, one port, and one tab. Give every round the same chain key (the plan `slug`, or the manifest's chain value). To run round N+1, write its plan and run `prototype ui` again. It reuses the running server, bumps the reload token, and the open tab reloads in place. It opens no new tab and blocks for the next decision. After an approve with notes, the tab shows "Building the next round from `<key>`" and keeps polling. To end the chain, approve with no notes (the tab closes and the server stops) or run `prototype stop <chain>`. Do not start a second server for a later round.

**Storage and `lineage.md`.** Keep each round in its own folder in the prototype's sandbox:

```
<name>/lineage.md
<name>/round-1/
<name>/round-2/
```

Each round folder holds its variants. Copy the previous winner into `round-N/base/` before you build, so every round can be rebuilt. For sub-shape A, the variant files stay in the app source with `prototype` and the round number in the path. Copy them into the round folder too.

`lineage.md` records one `## round-N` block per round, no wrapping heading. This is the same file and format the `--ext` mode writes (see [contracts.md](contracts.md) and [extension.md](extension.md) step 7):

```
## round-2
- base: round-1 C
- variants: A B C D E
- picked: B
- note: organize the buttons
- tweaks:
  - round the corners
- status: open
```

Write the block when the round starts. Fill `picked` and `note` when the user picks. Add the `tweaks:` list on the first tweak, one line per note, in order. Set `status: done` on the round that ends the chain. A round with a note stays `open` until the next round starts. Add the note to `lineage.md`, never to a second index. Keep `NOTES.md` for the question and the final answer, not for round history.

**Migrating an older prototype.** A prototype folder from before `lineage.md` existed keeps its round history in `NOTES.md` under a `## Rounds` heading, with `### round-N` headings. Read that section once, the same way `-c` below does, and write it into a new `lineage.md` on the next round; drop the legacy section from `NOTES.md` in the same pass.

**Flags in a chain**

- `-n` applies to every round. `-o` names only round 1.
- `--self-contained` carries through all rounds.
- `--publish` publishes only the final approved variant, after the chain ends.
- `--light`: say at the start, "This chain is in scratch and is lost on reboot."
- Bump the reload token after each round starts so the open tab shows the new variants. `prototype ui` does it for you when the chain key matches.

**Series.** For a planned set of prototypes, run each with `--series` and one shared `--chain=<series>`. An approve with no notes then keeps the tab and server. The page shows "Loading the next prototype" and keeps polling. The next `prototype ui <next> --series --chain=<series>` re-renders into the same server and the same tab reloads. Rounds inside one prototype work as usual. Run `prototype stop <series>` after the last pick.

**Resume with `-c` or `--continue [<name>]`**

1. Without a name, read `lineage.md` in each prototype folder under `.agents/prototype/` and keep the chains whose last round has `status: open`. When a folder has no `lineage.md` but its `NOTES.md` still carries a legacy `## Rounds` heading, read the rounds from there instead (and migrate them into a new `lineage.md` on the next round, per "Migrating an older prototype" above). Show the name, round number, last note, and age. One chain: use it. Two or more: ask the user to choose.
1. With a name, use that chain.
1. If the folder is missing, say so. For a `--light` chain, say it was lost on reboot or by the scratch cleanup. Do not rebuild it from memory.
1. Run `prototype status <name>` first (see "Claim an outstanding pick"). If a pick is waiting, claim it and start the next round.
1. If no pick is waiting and the last round has variants, show that round again. If its variants are not built, build them from the base in `NOTES.md`.

Do not add branching or a way back to an earlier round. Each round starts from the previous winner only.

### 6. Capture the answer and clean up

Once a variant has won, write down which one and why (commit message, ADR, issue, or `NOTES.md` when running unattended). Then:

- **Sub-shape A**: delete the losing variants and the switcher, and fold the winner into the existing page.
- **Sub-shape B**: promote the winning variant to a real route, and delete the throwaway route and the switcher.

Do not leave variant components or the switcher in the repo. They rot fast and confuse the next reader.

## Motion and animation variants

When the question is how something should move, the variants are timing curves, not layouts. The process above applies, with three additions.

- **Judge it against real chrome.** Inline a real screenshot of the host page as the stage background (`background-image: url(data:image/jpeg;base64,...)`, no live app needed). A 300 ms transition reads differently over real density than over a blank div.

- **Add a replay control, not only navigation.** The first-paint entry fires once per load. Reset to the origin position with the transition disabled, force a reflow, re-enable it, then re-trigger inside a double `requestAnimationFrame`. One frame still races the style write in some browsers.

  ```js
  el.style.transition = "none";
  place(originCorner, false);
  void el.offsetWidth;
  el.style.transition = prevTransition;
  requestAnimationFrame(() => requestAnimationFrame(() => place(targetCorner, true)));
  ```

- **Honor `prefers-reduced-motion: reduce` in every variant** with one global override:

  ```css
  @media (prefers-reduced-motion: reduce) {
    #el { transition: none !important; animation: none !important; }
  }
  ```

The decision bar is unchanged. Capture the backdrop in both modes, one capture each, swapped by the `html.dark` class the toggle drives. With one capture the toggle lies: the chrome stays light while the bar goes dark.

## Anti-patterns

- **Variants that differ only in color or copy.** That is a tweak, not a prototype. Real variants disagree about structure.
- **Sharing too much code between variants.** A shared `<Header>` is fine. A shared `<Layout>` defeats the point.
- **Wiring variants to real mutations.** Read-only prototypes are fine. If a variant must mutate, point it at a stub.
- **Promoting the prototype to production.** The variant code was written under prototype constraints. Rewrite it properly when you fold it in.
