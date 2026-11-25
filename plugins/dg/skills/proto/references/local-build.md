# Where the prototype lives

Default: **`.agents/prototype/<name>/`** in the project root.

- `.agents/` is tracked agent memory; prototype scratch is ignored and the `NOTES.md` answer stays tracked. On first use in a project, make sure `.gitignore` holds `.agents/prototype/*/*` and `!.agents/prototype/*/NOTES.md` (in a nested `.agents/.gitignore`: `prototype/*/*` and `!prototype/*/NOTES.md`). If it ignores all of `.agents/prototype/`, replace that line with these two. Commit that gitignore change on its own. Do not sweep it into prototype scaffolding.
- Every prototype artifact lives under its own `<name>/` folder: the terminal app script, scratch files, the sentinels, and the `NOTES.md` that captures the question and later the answer.
- **UI sub-shape A exception.** Variant components that must mount inside the app's routing tree live in the app's source, clearly marked as prototype. The `NOTES.md` and any standalone scratch still live under `.agents/prototype/<name>/`. The switcher component goes wherever shared UI lives in the project.

## `--light`

With `--light`, the prototype lives in scratch instead. Print its directory with
`dg prototype path <name> --light` (the sentinel path; its parent is the directory).
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
`dg prototype ui` opens its page itself. For anything else run
`dg prototype open <url-or-file>`; it is WSL-aware and falls back across platform openers.

## Rules that apply to every branch

1. **Throwaway from day one, and marked as such.** The only code that leaves the sandbox is UI variant code that must mount on a real route, and it still gets a name that shows it is a prototype. Follow whatever routing convention the project already uses.
2. **One command to run.** Use the project's existing task runner (`pnpm <name>`, `python <path>`, `bun <path>`). The user must be able to start it without thinking.
3. **No persistence by default.** State lives in memory. Persistence is the thing the prototype may be checking. If the question involves a database, hit a scratch database or a local file with a clear "PROTOTYPE, wipe me" name.
4. **Skip the polish.** No tests, no error handling beyond what makes it runnable, no abstractions.
5. **Surface the state.** After every action (logic) or variant switch (UI), print or render the full relevant state.
6. **Delete or absorb when done.** When the prototype has answered its question, delete it or fold the validated decision into the real code.

## Selection mechanism

A prototype with a running server records the user's decision as sentinel files:

1. The switcher bar has **Approve**, **Reject**, and **More versions** buttons that POST `{ name, action, variant, variants?, notes? }`. The route depends on the flow:
   - **Mounted in an app dev server** (React, Astro, Next): the switcher POSTs `/prototype-confirm`, handled by a copied endpoint template.
   - **Page served by `prototype serve` or `prototype ui`**: the injected client POSTs `/prototype-decision`.
   Use the template that matches the flow. A mismatched route 404s while `sendBeacon` still reports success, so the selection silently never arrives.
2. Block on the decision: `dg prototype wait <name> --json` (default timeout 900 seconds, set with `--timeout=<sec>`).
3. `wait` resolves on whichever sentinel appears first:
   - `.selection` written: `{"status":"ok","variant":"...","notes":"..."}`. The user approved a variant.
   - `.reject` written: `{"status":"rejected","notes":"..."}`. The user rejected. Rework and loop.
   - `.more` written: `{"status":"more","notes":"..."}`. The user wants more versions. Generate N new variants (default the same count as the round), steer them with the notes, and loop.
4. On timeout it prints `{"status":"timeout","pending":true}` (text mode prints `timeout, still pending`) and exits 124. The pick is still pending. Ask the user by hand, or run `wait` again. Exit 75 means the approve is recorded but the layout fingerprint was skipped for a reason you can fix: run the `run:` line that `wait` prints on stderr. A fingerprint step that passes its 60-second bound exits 0, because the pick is already on stdout; stderr still gives the `run:` line. Exit 1 is an error.

**Arm a waiter before you report the prototype live.** A builder subagent that mounts or serves a prototype
blocks on `dg prototype wait <chain> --json` itself, or returns the required field
`wait: dg prototype wait <chain> --json`. The main loop then starts that command in the background and runs
`dg prototype status <chain> --require-waiter`. A non-zero exit means no waiter is alive. Do not fire and
forget a backgrounded `wait`. When nothing else needs the session, prefer a foreground `wait`: if the runtime does not notify you when it exits, poll `prototype status <name>`
each turn. Sentinels are the source of truth, so a missed notification is always recoverable.

**The waiter file.** A running `wait` writes its pid to `<sandbox>/.waiter` and removes it on exit. `status`
prints `waiter: none; run: dg prototype wait <chain> --json` on stderr when no waiter is alive, and every
decision endpoint answers `{"ok": true, "waiter": false}`. The page then says "No agent is listening; tell
your agent to check." and keeps the tab open.

**A route behind a login.** Run `dg prototype sign-in <name> --sign-in=<loopback-url>` (or `--state=<name>`)
when you mount it. It writes `<sandbox>/.signin`, mode 0600, with only the URL and the state name. Every
later claim and `fingerprint` reads it, so the layout fingerprint is taken signed in.

**Tab behavior after a decision**

- **Approve, no notes**: the tab closes after 2.2 seconds.
- **Approve with notes**: the tab stays open and shows "Building the next round from `<key>`". Start the next refine round, bump the reload token, and the same tab reloads to the new variants. With `prototype ui`, reuse the same chain key and this happens by itself.
- **Reject** and **More versions**: the tab stays open in a "reworking" state and reloads when the reload token changes: `echo "$(date +%s)" > "$(dg prototype reload-path <name>)"`.

The tab favicon shows the decision state: waiting for the user's decision, processing a rework (reject or more sent, or approved with notes), or done (approved, no notes).

**Working directory.** `prototype serve` and `prototype wait` resolve the `--light` sentinel directory from their own working directory. A harness that resets the directory between tool calls makes the pick land in one directory while `wait` watches another. Drive the self-contained flow with `prototype ui` instead of wiring `serve` and `wait` by hand. It records the sentinel directory in the session, so `wait`, `status`, and `stop` for that chain key never depend on the ambient directory. Hand-wire `prototype serve` only when one document must own every variant (shared CSS, JS, or state, the usual shape of a motion prototype), and run both commands from the same directory every time.

**Working directory, mounted endpoint.** The copied endpoint templates pin their own `prototype path <name>` lookup to the repo root (`git rev-parse --show-toplevel`), the same root the agent's own shell normally runs from — not to the dev server's own launch directory, which is often a sub-package. Without that pin, a dev server launched from a workspace subdirectory and an agent running `prototype wait` from the repo root can silently resolve two different `.agents/prototype/<name>/` folders, and a real click never surfaces. This is already built into every shipped template; do not hand-roll an endpoint that drops it.

**`--light` with a mounted endpoint.** Export `PROTOTYPE_LIGHT=1` in the dev server's environment before launching it. The endpoint reads it to write the sentinel where the `--light` waiter is watching. Without it, the endpoint writes under `.agents/` and `wait --light` times out with no feedback. `prototype serve` learns `--light` from its own arguments and needs no variable.

**Endpoint security.** Dev only, localhost only. The variant key is checked against the caller-supplied list for `confirm`. The check is skipped for `reject` and `more`.

**Who made the pick.** Every sentinel write also records `.source`: `browser` from a real page click (`prototype serve`, `prototype ui`, and every endpoint template), `cli` from `prototype confirm` run directly, or whatever `prototype confirm --source=TEXT` named. `prototype status <name> --json` prints `{"status":...,"source":...}`; the plain (non-JSON) form is unchanged. Use this to tell a real decision apart from one recorded by hand.

**Self-testing a decision bar before handing it over.** Verifying that Approve/Reject actually post correctly (see "Rendering — local-first, ALWAYS") is a real click against a real endpoint, and it writes a real sentinel — never run it against the prototype's own `<name>`, or the self-test pick and the user's real one become indistinguishable. For a CLI check, run `prototype confirm <name> <variant> --selftest` (it writes to `<name>-selftest`, a throwaway sentinel directory `wait` and `status` for `<name>` never look at). For a real click against a mounted endpoint or a self-contained `prototype serve`/`prototype ui` page, POST with `selftest: true` in the body instead; every shipped endpoint template, and the self-contained server's `/prototype-decision`, redirect that request to the same `<name>-selftest` directory and never touch `<name>`'s own sentinels. Then confirm the real name is still clean before calling the page live and again right before any `prototype wait <name>`:

```sh
dg prototype status <name> --require-pending
```

`--require-pending` exits non-zero with an error instead of printing a stale status when `<name>` is not `pending` — run it right before reporting the prototype as ready, and again right before blocking on `wait`, treating a non-zero exit as a bug to find, not a status to report. Once a pick does land in `<name>`'s own sentinel, claim and act on it directly; a verdict a human did not approve never reaches that sentinel in the first place, so there is nothing left to confirm.

**Reload-in-place for a mounted endpoint.** The Astro switcher polls the same `/prototype-confirm` route with `{action:"status"}` every 2s and reloads when the returned reload token changes; no separate GET route exists for this. React, Next, and Vite switchers skip polling entirely and rely on their dev server's own HMR instead.

## Shipped templates

`dg prototype components` prints the installed directory that holds the copyable templates. Copy a file into the project instead of writing one from scratch.

| File | Use |
|---|---|
| `PrototypeSwitcher.tsx` | React, Next, or Vite switcher bar with Approve, Reject, More versions, and notes |
| `PrototypeSwitcher.astro` | Astro switcher bar with the same controls |
| `prototype-decision-bar.html` | Decision-only bar for a hand-written self-contained page |
| `prototype-endpoint.ts` | Express, Vite, or Bun endpoint for `POST /prototype-confirm` |
| `prototype-endpoint.next.ts` | Next App Router route for `POST /prototype-confirm` |
| `prototype-endpoint.astro.ts` | Astro route, copied to `src/pages/api/prototype-confirm.ts` |
| `webmcp-tools.json` | Read-only WebMCP tool definitions; `dg prototype webmcp` prints them |

See [../assets/README.md](../assets/README.md) for the switcher props and behavior.

**A host with no shipped endpoint template** (for example ASP.NET): port `prototype-endpoint.ts` to the host stack and keep all four actions: `confirm`, `reject`, `more`, and `status`. The `more` action writes the `.more` sentinel. Keep the waiter check too: every reply carries `waiter`, true only while the pid in `<sandbox>/.waiter` is alive, and the bar shows "No agent is listening; tell your agent to check." when a pick answers `waiter: false`. Then either build the bar from the same four actions, or mount `prototype-decision-bar.html` against the ported endpoint. Never drop the `more` action: without it the user cannot ask for more versions, and `prototype wait` can never report `more`.

## `--publish`

With `--publish`, publish the winning variant as a shareable Artifact after the selection is confirmed.

1. **Fetch the winning variant's HTML.** Prefer an already-installed Playwright (through the `pw` skill or an MCP tool): navigate to `http://localhost:<port>?variant=<key>` and read `document.documentElement.outerHTML`. Never install Playwright or download a browser for this step. Fall back to `curl -s "http://localhost:<port>?variant=<key>"`.
2. **Strip the switcher bar.** Remove the switcher element (`id="prototype-switcher"` or the fixed bar at the bottom). It is tooling, not the design being shared.
3. **Write to scratch.** Save the cleaned HTML to a file under the scratch directory printed by `dg stash prototype <name>-variant-<key>.html`.
4. **Publish with the Artifact tool.** Title `<name>, variant <key>`. Label `variant-<key>-selected`. File: the scratch path.
5. **Print the Artifact URL.**

Without a prior selection, default to `?variant=A`, or the current URL parameter when the user is browsing.
Port resolution order: `$PROTOTYPE_PORT`, then `4321` (Astro), then `3000` (Next, Vite). If the port is unknown, ask.
`--light` with `--publish` works the same way. Publish only the final approved variant of a chain.

## Rendering: local first, always

A prototype that does not render is worthless. Never `<script src>` or `<link href>` an external
URL (CDN scripts, web fonts) in a prototype: it renders blank when the network is blocked.
Vendor or inline every dependency, or hand-render to plain HTML and CSS.

**The local mode never reaches the network at run time.** Never install a package or framework, and
never fetch one from the network, to satisfy this: use what the project already has installed. If a
dependency is genuinely missing, stop and name the one command the user should run (the same way the
pw skill asks before `pw install-browser`) and let them run it. `--ext` mode never writes a browser
download either: the extension hands scrape and plant results straight to the CLI over the paired
dg session. A `~/Downloads/dg-proto/` folder from an older `dg` version is safe to
delete; nothing reads or writes it anymore.

A prototype of an existing app's UI renders **in that app**. When the thing being prototyped is a
page, panel, dialog, or component of a web app in the repo, mount the variants in the real running
app (UI sub-shape A in [references/local-ui.md](local-ui.md)). Never rebuild the app's chrome as a standalone
look-alike: the user then judges the copy, not the design.

With no host app, or with `--self-contained`, serve the content on the `prototype serve` page
with `dg prototype ui`. Prose, tables, code, and compare cards are plain HTML inside a
variant, so no other viewer is needed. See [references/local-formats.md](local-formats.md).

Verify the page renders before handing it over. Load it (an already-installed Playwright, through
the `pw` skill or an MCP tool, or a headless check of the produced HTML) and confirm the real
content is present — never install Playwright or download a browser for this check. Never ask "does
this look right?" about a page you have not confirmed renders.

## When done

The answer is the only thing worth keeping from a prototype. Capture it somewhere durable (commit
message, ADR, issue, or the `NOTES.md` next to the prototype) along with the question it answered.
If the user is around, that capture is a quick conversation. If not, leave the placeholder so they,
or you on the next pass, can fill in the verdict before deleting the prototype.

Returning to a prototype rather than building one? A UI prototype's pick may already be sitting
unclaimed. See "Claim an outstanding pick" in [references/local-ui.md](local-ui.md) before assuming the verdict was lost.

## When a prototype feeds a planning document

If a planning document (a `/dg:spec` spec, a plan, a `/dg:prd` deliverable) references the
prototype's outcome, the prototype stops being throwaway for the life of that plan and becomes the
source of truth for the design it settled.

1. **Keep the asset available.** The prototype must live in the durable `.agents/prototype/<name>/` location, never only in the `--light` scratch sandbox, which is wiped on reboot while the plan is still open. If it was built with `--light`, copy it into `.agents/prototype/<name>/` before referencing it. Record its path, and the winning variant key for a UI prototype, in the planning document.
   Link the planning document to the text-only `ACCEPTED.md` and `accepted.json` that the `/dg:spec` plan step copies into the bundle from the sandbox record with `prototype-ref`. Every variant's feature root carries `data-verify-root="<prototype name>"`, so `/dg:verify` can compare the built layout with the accepted one. Give every control that shows record data a `data-testid`, so its identity survives changed data. Never commit screenshots.
2. **Follow it completely.** Agents that implement a prototyped decision reproduce the prototype's design and feature set faithfully. Do not silently drop features or re-decide the look or flow it already resolved.
3. **Ask when it does not fit the code.** Where the prototype conflicts with the current code design (data shape, existing components, framework limits it could not see), surface the mismatch instead of diverging or force-fitting. Ask directly when interactive, or escalate to the orchestrator inside a workflow that forbids prompts.
