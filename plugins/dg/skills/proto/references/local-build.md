# Where the prototype lives

Default: **`.agents/prototype/<name>/`** in the project root.

- On first use in a project, make sure `.agents/prototype/` is gitignored. Add the line to `.gitignore` (or `.agents/.gitignore` when the project keeps a nested one) if it is missing. Commit that gitignore change on its own. Do not sweep it into prototype scaffolding.
- Every prototype artifact lives under its own `<name>/` folder: the terminal app script, scratch files, the sentinels, and the `NOTES.md` that captures the question and later the answer.
- **UI sub-shape A exception.** Variant components that must mount inside the app's routing tree live in the app's source, clearly marked as prototype. The `NOTES.md` and any standalone scratch still live under `.agents/prototype/<name>/`. The switcher component goes wherever shared UI lives in the project.

## `--light`

With `--light`, the prototype lives in scratch instead. Print its directory with
`~/.dg/bin/dg-skills prototype path <name> --light` (the sentinel path; its parent is the directory).
Use `--light` when:

- The prototype is throwaway-throwaway: answered in one session, never revisited.
- The project has no `.agents/` directory and you do not want to introduce one.
- The user wants nothing to touch the repo.

The `--light` sandbox is wiped on reboot, so lift anything worth keeping (the `NOTES.md` answer)
into a commit message or ADR before the session ends. A refine chain started with `--light` is
lost on reboot too. Say so when the chain starts.

**Plan walkthroughs ignore `--light`.** A walkthrough ([local-plan.md](local-plan.md)) always lives in
`.agents/prototype/<name>/`, even under `--light`. It is a durable reference while the plan is specced.

## `--self-contained`

With `--self-contained`, render the prototype as a **single self-contained HTML file** (inline
CSS and JS, no build step, no dev server), whatever the host project's stack. Use it when the user
wants something that opens with zero tooling, or a file to share.

- It matters most for the plan walkthrough, whose framework-aware default would otherwise mount inside a JS-framework host.
- For the UI-variants branch it means emitting the variants into one static page served by `prototype ui` (see [local-formats.md](local-formats.md)) instead of mounting on a route.
- It does not change the location rules above.

**Open the prototype in the browser the moment it is ready**, for every branch. Do not make the user paste a URL.
`~/.dg/bin/dg-skills prototype ui` opens its page itself. For anything else run
`~/.dg/bin/dg-skills prototype open <url-or-file>`; it is WSL-aware and falls back across platform openers.

## Rules that apply to every branch

1. **Throwaway from day one, and marked as such.** The only code that leaves the sandbox is UI variant code that must mount on a real route, and it still gets a name that shows it is a prototype. Follow whatever routing convention the project already uses.
2. **One command to run.** Use the project's existing task runner (`pnpm <name>`, `python <path>`, `bun <path>`). The user must be able to start it without thinking.
3. **No persistence by default.** State lives in memory. Persistence is the thing the prototype may be checking. If the question involves a database, hit a scratch database or a local file with a clear "PROTOTYPE, wipe me" name.
4. **Skip the polish.** No tests, no error handling beyond what makes it runnable, no abstractions.
5. **Surface the state.** After every action (logic) or variant switch (UI), print or render the full relevant state.
6. **Delete or absorb when done.** When the prototype has answered its question, delete it or fold the validated decision into the real code.

## Selection mechanism

A prototype with a running server records the user's decision as sentinel files:

1. The switcher bar has **Approve** and **Reject** buttons that POST `{ name, action, variant, variants?, notes? }`. The route depends on the flow:
   - **Mounted in an app dev server** (React, Astro, Next): the switcher POSTs `/prototype-confirm`, handled by a copied endpoint template.
   - **Page served by `prototype serve` or `prototype ui`**: the injected client POSTs `/prototype-decision`.
   Use the template that matches the flow. A mismatched route 404s while `sendBeacon` still reports success, so the selection silently never arrives.
2. Block on the decision: `~/.dg/bin/dg-skills prototype wait <name> --json` (default timeout 900 seconds, set with `--timeout=<sec>`).
3. `wait` resolves on whichever sentinel appears first:
   - `.selection` written: `{"status":"ok","variant":"...","notes":"..."}`. The user approved a variant.
   - `.reject` written: `{"status":"rejected","notes":"..."}`. The user rejected. Rework and loop.
4. On timeout it prints `{"status":"timeout"}` and exits 1. Ask the user by hand.

Do not fire and forget a backgrounded `wait`: completion may not surface. Prefer the foreground. If it
must be backgrounded, poll `prototype status <name>` each turn. Sentinels are the source of truth, so a
missed notification is always recoverable.

**Tab behavior after a decision**

- **Approve, no notes**: the tab closes after 2.2 seconds.
- **Approve with notes**: the tab stays open and shows "Building the next round from `<key>`". Start the next refine round, bump the reload token, and the same tab reloads to the new variants. With `prototype ui`, reuse the same chain key and this happens by itself.
- **Reject**: the tab stays open in a "reworking" state and reloads when the reload token changes: `echo "$(date +%s)" > "$(~/.dg/bin/dg-skills prototype reload-path <name>)"`.

The tab favicon shows the decision state: waiting for the user's decision, processing a rework (reject sent or approved with notes), or done (approved, no notes).

**Working directory.** `prototype serve` and `prototype wait` resolve the `--light` sentinel directory from their own working directory. A harness that resets the directory between tool calls makes the pick land in one directory while `wait` watches another. Drive the self-contained flow with `prototype ui` instead of wiring `serve` and `wait` by hand. It records the sentinel directory in the session, so `wait`, `status`, and `stop` for that chain key never depend on the ambient directory. Hand-wire `prototype serve` only when one document must own every variant (shared CSS, JS, or state, the usual shape of a motion prototype), and run both commands from the same directory every time.

**Working directory, mounted endpoint.** The copied endpoint templates pin their own `prototype path <name>` lookup to the repo root (`git rev-parse --show-toplevel`), the same root the agent's own shell normally runs from — not to the dev server's own launch directory, which is often a sub-package. Without that pin, a dev server launched from a workspace subdirectory and an agent running `prototype wait` from the repo root can silently resolve two different `.agents/prototype/<name>/` folders, and a real click never surfaces. This is already built into every shipped template; do not hand-roll an endpoint that drops it.

**`--light` with a mounted endpoint.** Export `PROTOTYPE_LIGHT=1` in the dev server's environment before launching it. The endpoint reads it to write the sentinel where the `--light` waiter is watching. Without it, the endpoint writes under `.agents/` and `wait --light` times out with no feedback. `prototype serve` learns `--light` from its own arguments and needs no variable.

**Endpoint security.** Dev only, localhost only. The variant key is checked against the caller-supplied list for `confirm`. The check is skipped for `reject`.

## Shipped templates

`~/.dg/bin/dg-skills prototype components` prints the installed directory that holds the copyable templates. Copy a file into the project instead of writing one from scratch.

| File | Use |
|---|---|
| `PrototypeSwitcher.tsx` | React, Next, or Vite switcher bar with Approve, Reject, and notes |
| `PrototypeSwitcher.astro` | Astro switcher bar with the same controls |
| `prototype-decision-bar.html` | Decision-only bar for a hand-written self-contained page |
| `prototype-endpoint.ts` | Express, Vite, or Bun endpoint for `POST /prototype-confirm` |
| `prototype-endpoint.next.ts` | Next App Router route for `POST /prototype-confirm` |
| `prototype-endpoint.astro.ts` | Astro route, copied to `src/pages/api/prototype-confirm.ts` |
| `webmcp-tools.json` | Read-only WebMCP tool definitions; `~/.dg/bin/dg-skills prototype webmcp` prints them |

See [../assets/README.md](../assets/README.md) for the switcher props and behavior.

## `--publish`

With `--publish`, publish the winning variant as a shareable Artifact after the selection is confirmed.

1. **Fetch the winning variant's HTML.** Prefer Playwright: navigate to `http://localhost:<port>?variant=<key>` and read `document.documentElement.outerHTML`. Fall back to `curl -s "http://localhost:<port>?variant=<key>"`.
2. **Strip the switcher bar.** Remove the switcher element (`id="prototype-switcher"` or the fixed bar at the bottom). It is tooling, not the design being shared.
3. **Write to scratch.** Save the cleaned HTML to a file under the scratch directory printed by `~/.dg/bin/dg-skills stash prototype <name>-variant-<key>.html`.
4. **Publish with the Artifact tool.** Title `<name>, variant <key>`. Label `variant-<key>-selected`. File: the scratch path.
5. **Print the Artifact URL.**

Without a prior selection, default to `?variant=A`, or the current URL parameter when the user is browsing.
Port resolution order: `$PROTOTYPE_PORT`, then `4321` (Astro), then `3000` (Next, Vite). If the port is unknown, ask.
`--light` with `--publish` works the same way. Publish only the final approved variant of a chain.
