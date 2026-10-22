# UI Prototype

Generate **several radically different UI variations** on a single route, switchable from a floating bottom bar. The user flips between variants in the browser, picks one (or steals bits from each), then throws the rest away.

If the question is about logic/state rather than what something looks like — wrong branch. Use [logic.md](logic.md).

## When this is the right shape

- "What should this page look like?"
- "I want to see a few options for this dashboard before committing."
- "Try a different layout for the settings screen."
- Any time the user would otherwise spend a day picking between three vague mockups in their head.

## Two sub-shapes — sub-shape A is mandatory when a host page exists

A UI prototype is much easier to judge when it's **butting up against the rest of the app** — real header, real sidebar, real data, real density. A throwaway route on its own is a vacuum: every variant looks fine in isolation. Use sub-shape A whenever there's a plausible existing page to host the variants. Only reach for sub-shape B if the prototype genuinely has no nearby home.

**Never substitute a standalone HTML look-alike for an app page.** `dg-skills prototype ui` plans and hand-written HTML pages are for prototypes with no host app, or for an explicit `--self-contained`. If the prototype is part of a web app in the repo, the variants run inside that app, with its real components, styles, and layout. Before handing over, compare a screenshot of the prototype with the real page: if the header, navigation, fonts, or grid look different, it is not mounted in the app and is not done.

### When the app is hard to run

Each of these has a fixed answer. None of them is a reason to build a standalone page.

- **The app's worktree is busy** (another agent is rebasing or editing it, or it has uncommitted work): create a throwaway detached worktree from the same ref (`git worktree add --detach <path> <ref>`), mount the variants there, and remove the worktree when the prototype is done.
- **No backend or database locally**: point the app's API base URL at a small local mock server (Bun) that serves every endpoint the page calls on load, with fake data and a little latency so loading states show. Keep the mock under the prototype's sandbox.
- **Auth blocks the page**: find how the app loads its session (URL tokens, local storage, cookies) and give the mock fake tokens and an admin user. Hand the user one sign-in URL that lands on the page with `?variant=` set.
- **A default port is taken**: pick a free port. Never kill a process you did not start.

### Sub-shape A — adjustment to an existing page (preferred)

The route already exists. Variants are rendered **on the same route**, gated by a `?variant=` URL search param. The existing data fetching, params, and auth all stay — only the rendering swaps. This is the default; pick it unless there's a specific reason not to.

If the prototype is for something that doesn't yet have a page but *would naturally live inside one* (a new section of the dashboard, a new card on the settings screen, a new step in an existing flow) — that's still sub-shape A. Mount the variants inside the host page.

### Sub-shape B — a new page (last resort)

Only use this when the thing being prototyped genuinely has no existing page to live inside — e.g. an entirely new top-level surface, or a flow that can't be embedded anywhere sensible.

Create a **throwaway route** following whatever routing convention the project already uses — don't invent a new top-level structure. Name it so it's obviously a prototype (e.g. include the word `prototype` in the path or filename). Same `?variant=` pattern.

Before committing to sub-shape B, sanity-check: is there really no existing page this could be embedded in? An empty route hides design problems that a populated one would expose.

In both sub-shapes the floating bottom bar is identical.

## Process

### 0. Pick the location

Default sandbox is the durable `.agents/prototype/<name>/`; under `--light` it's the ephemeral scratch sandbox. See [build.md](build.md) "Where the prototype lives".

UI is a partial exception: variant components and the switcher that must mount on a real route have to live inside the app's source tree (route files, components dir, etc.) so the framework can reach them. Everything else — the `NOTES.md`, the planning blurb, screenshots, scratch JSON fixtures — lives under `<name>/` in the sandbox. Name in-source variant files with `prototype` in the path so they're obvious, and list them in `NOTES.md` so cleanup is trivial.

### 1. State the question and pick N

Default to **5 variants**, keyed `A` to `E`. `-n` raises or lowers that with no upper limit; keep each variant radically different from the others.

- `-n <count>` / `--count <count>` sets the number (1 or more, keys `A`, `B`, ...; past `Z` use `AA`, `AB`, ...).
- `-o "<a>,<b>"` / `--options "<a>,<b>"` names the directions. Build exactly one variant per name, in the order given, and no others. Use each name as that variant's label. `-o` overrides `-n`.
- Pad nothing. Two names mean two variants, even though the default is five.

Write down the plan in one line in `<name>/NOTES.md` (or a top-of-file comment if the prototype is a single in-source file).

### 2. Generate radically different variants

Draft each variant. Hold each one to:

- The page's purpose and the data it has access to.
- The project's component library / styling system (TailwindCSS, shadcn, MUI, plain CSS, whatever).
- A clear exported component name, e.g. `VariantA`, `VariantB`, `VariantC`.

Variants must be **structurally different** — different layout, different information hierarchy, different primary affordance, not just different colours. Three slightly-tweaked card grids isn't a UI prototype, it's wallpaper. If two drafts come out too similar, redo one with explicit "do not use a card grid" guidance.

### 3. Wire them together (sub-shape A/B — mounted in a real app)

Create a single switcher component on the route, reading `?variant=` and rendering the matching variant. Keep all existing data fetching above the switcher; only the rendered subtree changes per variant.

**Use the shared template — don't write from scratch.** Copy the appropriate file from `dg-skills prototype components` (prints the installed path):
- `PrototypeSwitcher.tsx` for React/Next/Vite projects
- `PrototypeSwitcher.astro` for Astro projects

Pass `labels` (variant key → human description) so the bar renders `slug · KEY — description`.

Expose the selection endpoint by copying `prototype-endpoint.ts` (Node/Vite/Bun/Express) or `prototype-endpoint.astro.ts`/`prototype-endpoint.next.ts` (Astro/Next) from the same directory into the framework's API directory. The endpoint resolves the sentinel via `~/.dg/bin/dg-skills prototype selection path <name>` and is dev-only (`NODE_ENV !== 'production'` guard — do not remove it).

### 4. No host app — render with `dg-skills prototype ui`

When there is genuinely no app to mount in (sub-shape B with no throwaway route, or an explicit `--self-contained`), skip hand-wiring entirely and drive the self-contained flow:

```sh
~/.dg/bin/dg-skills prototype ui <plan.json|-> [--light] [--port=N] [--timeout=SEC]
```

This renders the plan's variants into a page with the full switcher + decision bar, serves + opens it, blocks for the decision, and prints one JSON line (`{"status":"ok","variant":"B","notes":"..."}` / `{"status":"rejected","notes":"..."}` / `{"status":"timeout"}`). See [ui-generate.md](ui-generate.md) for the plan format and worked examples, and [commands.md](commands.md) for every subcommand.

**Rework loop:** on reject, edit the plan and run the exact same command again. `prototype ui` recognizes the session by the plan's slug, reuses the already-running server (re-renders in place and bumps the reload token) instead of starting a new one, and the open tab refreshes on its own.

`dg-skills prototype ui wait <name>` / `dg-skills prototype ui status <name>` check in on a session from a different shell or after a compacted context, anchored to the session's recorded state rather than ambient cwd.

**Hand-wire `dg-skills prototype serve` instead** only when one document has to own every variant — shared CSS/JS/state (custom properties, a shared position/animation module, an inlined screenshot background) that per-variant fragments can't express. This is the usual shape for a motion/animation prototype (see "Motion & animation variants" below). Paste `prototype-decision-bar.html` into the page, then:

```sh
~/.dg/bin/dg-skills prototype serve <html-file> <name> --port=4321
variant=$(~/.dg/bin/dg-skills prototype selection wait <name> --timeout=3600 --json)
```

Read the port `prototype serve` actually printed — it auto-increments past a taken port, so the one you asked for may not be the one it's listening on.

### 5. Hand it over

**Render local-first and verify before handing over** (see SKILL.md "Rendering — local-first, ALWAYS"): render a self-contained HTML page and serve it with `dg-skills prototype serve` / `dg-skills prototype ui` directly. Confirm the page actually renders (Playwright MCP, or a Node/headless check of the produced HTML) before you show it. Do not ask "does this look right?" about a page you haven't confirmed renders.

**Never hand over a prototype whose only affordance is switching variants.** A UI prototype the user is meant to *decide* on MUST carry the notes box + **Approve ✓** / **Reject ⟲** buttons wired to the selection sentinel, not just prev/next navigation — and the agent must then block on `dg-skills prototype selection wait` (or `prototype ui wait`) before treating the prototype as delivered, or say plainly why it can't.

**Auto-open the prototype in the browser as soon as it builds** — don't make the user paste the URL. Run `dg-skills prototype open <url>` (WSL-aware). Then still surface the URL + `?variant=` keys as a fallback for reopening.

**The sentinel is durable — a verdict is never lost, only unclaimed.** The browser Approve (or `dg-skills prototype selection confirm`) writes `.selection` + `.notes`; Reject writes `.reject`. These files live under the prototype dir and are the source of truth — they outlive the `wait` process, a backgrounded shell, a compacted context, and the session itself.

**So re-check the sentinel on every re-entry to an outstanding prototype:**

```sh
~/.dg/bin/dg-skills prototype selection status <name>          # non-consuming: prints the variant, "rejected", or "pending"
# if it isn't "pending", claim it (this consumes the sentinel + notes):
~/.dg/bin/dg-skills prototype selection wait <name> --timeout=1
```

**Do NOT rely on a live foreground `wait` surviving the session.** If you launch `wait` in the background, or hand the prototype off while a pick is still outstanding, leave a durable breadcrumb: record the prototype **name** and the literal `dg-skills prototype selection wait <name>` re-check command **both** in the handoff/snapshot note **and** in `NOTES.md`.

The selected variant is now available as `$variant` for any downstream steps (e.g. `--publish`). The interesting feedback is usually **"I want the header from B with the sidebar from C"** — that's the actual design they want.

### 5.5 Refine chain (approve with a note)

At the pick step, read the result of `dg-skills prototype selection wait <name> --json` (or `prototype ui`'s own printed JSON):

- `approve <key>` with no notes: the chain ends. Go to §6.
- `approve <key>` with notes: the winner is the base of the next round. Build `-n` new variants from it. Change only what the notes ask. Keep everything else in the base exactly as it is.
- The user types `tweak <key>: <note>`: apply the note to that variant in place, in the current round. Build no new variants, start no new round, and do not end the chain. Append the note to the round's `tweaks:` list in `lineage.md`, bump the reload token, and show the variant again for a pick.
- The user says "done" or "stop": the chain ends with the last picked variant. Go to §6.
- Reject: rework the same round as before.

**Storage.** Keep each round in its own folder in the prototype's sandbox:

```
<name>/lineage.md
<name>/round-1/
<name>/round-2/
```

Each round folder holds its variants. Copy the previous winner into `round-N/base/` before you build, so every round can be rebuilt. For sub-shape A, the variant files stay in the app source with `prototype` and the round number in the path. Copy them into the round folder too.

**`lineage.md`.** One block per round:

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

**Flags in a chain.**
- `-n` applies to every round. `-o` names only round 1.
- `--self-contained` carries through all rounds.
- `--publish` publishes only the final approved variant, after the chain ends.
- `--light`: say at the start, "This chain is in scratch and is lost on reboot."
- Bump the reload token after each round starts so the open tab shows the new variants.

**Resume with `-c` / `--continue [<name>]`.**
1. Without a name, read `lineage.md` in each prototype folder and keep the chains whose last round has `status: open`. Show name, round number, last note and age. One chain: use it. Two or more: ask the user to choose.
2. With a name, use that chain.
3. If the folder is missing, say so. For a `--light` chain, say it was lost on reboot. Do not rebuild it from memory.
4. Run `dg-skills prototype selection status <name>` first. If a pick is waiting, claim it and start the next round.
5. If no pick is waiting and the last round has variants, show that round again for a pick. If its variants are not built, build them from the base in `lineage.md`.

### 6. Capture the answer and clean up

Once a variant has won, write down which one and why (commit message, ADR, issue, or a `NOTES.md` next to the prototype). Then:

- **Sub-shape A** — delete the losing variants and the switcher; fold the winner into the existing page.
- **Sub-shape B** — promote the winning variant to a real route, delete the throwaway route and the switcher.

Don't leave variant components or the switcher lying around.

## Motion & animation variants

When the question is "how should this move," not "how should this look," the variants are timing curves, not layouts — same process above, with three additions:

- **Judge it against real chrome.** Inline a real screenshot of the host page as the stage background, no live app or server needed — a 300ms transition reads completely differently over real density than over a blank div.
- **Add a replay control, not just navigation.** Reset to the origin position with the transition disabled, force a reflow, re-enable it, then re-trigger inside a double `requestAnimationFrame`.
- **Honor `prefers-reduced-motion: reduce` in every variant** — one global override, not a per-variant opt-in.

The decision bar is unchanged — `prototype-decision-bar.html` same as any other self-contained prototype. Capture the backdrop in both light and dark mode; a motion prototype judged against a real screenshot needs one capture per mode, swapped by the `html.dark` class the toggle drives.

## Anti-patterns

- **Variants that differ only in colour or copy.** That's a tweak, not a prototype. Real variants disagree about structure.
- **Sharing too much code between variants.** A shared `<Header>` is fine; a shared `<Layout>` defeats the point. Each variant should be free to throw out the layout.
- **Wiring variants to real mutations.** Read-only prototypes are fine. If a variant needs to mutate, point it at a stub.
- **Promoting the prototype directly to production.** The variant code was written under prototype constraints. Rewrite it properly when you fold it in.
