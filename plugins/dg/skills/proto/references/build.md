# Where the prototype lives

Default: **`$(~/.dg/bin/dg-skills prototype dir <name>)/`** in the project root
(equivalently, `.agents/prototype/<name>/`).

- On first use in a project, ensure `.agents/prototype/` is gitignored. Add the line to `.gitignore` (or `.agents/.gitignore` if the project keeps a nested one) if missing. Commit that gitignore change on its own — don't sweep it into prototype scaffolding.
- Every prototype artifact lives under its own `<name>/` subfolder: the TUI script, any scratch files, the `NOTES.md` capturing the question and (later) the answer.
- **UI sub-shape A exception** — variant components that must mount inside the app's routing tree obviously have to live in the app's source. In that case, the variant files still go in source (clearly marked as prototype), but the `NOTES.md` and any standalone scratch live under `$(~/.dg/bin/dg-skills prototype dir <name>)/`. The switcher component goes wherever shared UI lives in the project.

### `--light` flag

When invoked as `/dg:proto ... --light`, drop the prototype under **`$(~/.dg/bin/dg-skills prototype dir <name> --light)/`** instead (pass `--light` through to every `dg-skills prototype` subcommand too — see [commands.md](commands.md)). Use this when:

- The prototype is genuinely throwaway-throwaway — answered in one session, never revisited.
- The project doesn't have a `.agents/` directory and you don't want to introduce one.
- The user explicitly wants nothing touching the repo.

The `--light` sandbox is wiped on reboot, so anything captured needs to be lifted out (NOTES.md → commit message / ADR) before the session ends. A refine chain (ui.md §5.5) started with `--light` is lost on reboot too; say so when the chain starts.

**Plan walkthroughs ignore `--light`.** A plan/multi-workflow walkthrough ([plan.md](plan.md)) always lives in the durable sandbox, even under `--light` — it's a durable reference while the plan is being specced, so it must not be stranded in scratch.

### `--self-contained` flag

When invoked as `/dg:proto ... --self-contained`, render the prototype as a **single self-contained HTML file** (inline CSS/JS, no build step), served locally by `dg-skills prototype serve`, regardless of the host project's stack. Use when the user wants something that opens with zero tooling or to share the file directly.

**Always auto-open the prototype in the browser the moment it's ready** — for every branch and sub-shape, don't make the user paste a URL or path. Run `dg-skills prototype open <url-or-file>`; it's WSL-aware, with `xdg-open`/`open` fallbacks on other platforms.

- Most relevant to the **plan walkthrough** branch ([plan.md](plan.md)), whose framework-aware default would otherwise mount inside a JS-framework host. `--self-contained` overrides that and forces the standalone file.
- For the **UI variants** branch, this means rendering the variants + switcher into one self-contained page via `dg-skills prototype ui` instead of mounting on a route.
- It does **not** change the location rules above: the file still lands in the durable sandbox (or the `--light` sandbox for non-plan prototypes).

## Rules that apply to both

1. **Throwaway from day one, and clearly marked as such.** Default location is the durable sandbox (or the `--light` sandbox) — see "Where the prototype lives" above. The only thing that escapes the sandbox is UI variant code that *must* mount on a real route; that code still gets named so a casual reader can see it's a prototype, not production. For throwaway UI routes, obey whatever routing convention the project already uses; don't invent a new top-level structure.
2. **One command to run.** Whatever the project's existing task runner supports — `pnpm <name>`, `python <path>`, `bun <path>`, etc. The user must be able to start it without thinking.
3. **No persistence by default.** State lives in memory. Persistence is the thing the prototype is _checking_, not something it should depend on. If the question explicitly involves a database, hit a scratch DB or a local file with a clear "PROTOTYPE — wipe me" name.
4. **Skip the polish.** No tests, no error handling beyond what makes the prototype _runnable_, no abstractions. The point is to learn something fast and then delete it.
5. **Surface the state.** After every action (logic) or on every variant switch (UI), print or render the full relevant state so the user can see what changed.
6. **Delete or absorb when done.** When the prototype has answered its question, either delete it or fold the validated decision into the real code — don't leave it rotting in the repo.

## Selection mechanism

Local UI-variant and plan-walkthrough prototypes support in-browser decisions via a sentinel-file loop, driven entirely by `dg-skills prototype`:

1. The served page (either `dg-skills prototype ui`'s own switcher bar, or a hand-wired page carrying `prototype-decision-bar.html`) POSTs `{ name, action, variant, notes? }` to `POST /prototype-decision`, which `dg-skills prototype serve` wires in.
2. The agent blocks on a decision: `dg-skills prototype selection wait <name> --json` (default 15-minute timeout; pass `--timeout=<sec>` to override).
3. `wait` resolves on whichever sidecar appears first: `.selection` → `{"status":"ok","variant":"...","notes":"..."}`; `.reject` → `{"status":"rejected","notes":"..."}`.
4. On timeout, the command exits 1 and prints `{"status":"timeout"}` — ask the user manually.

**Don't fire-and-forget a backgrounded wait** — completion may not surface. Prefer foreground; if backgrounded, poll `dg-skills prototype selection status <name>` each turn. Sentinels are the source of truth, so a missed notification is always recoverable.

**Tab behavior after a decision:**
- **Approve, no notes** → tab auto-closes after 2.2s, and `dg-skills prototype ui` tears its server down.
- **Approve with notes** → tab stays open; agent starts a new refine round (see [ui.md](ui.md) §5.5), re-runs `dg-skills prototype ui` with the revised plan (it reuses the running server and bumps the reload token), and the page refreshes.
- **Reject** → tab stays open in a "reworking" state; page auto-refreshes once the agent bumps the reload token (`dg-skills prototype decision reload-path <name>`).

**`prototype ui` fixes the cwd-pickup bug for you.** A harness that resets cwd between tool calls would otherwise make a fresh `dg-skills prototype selection wait` resolve a different sentinel directory than the one the server is writing into. `dg-skills prototype ui` pins its session to one recorded cwd, so this can't happen — use it instead of hand-wiring `serve` + `selection wait` yourself whenever the per-variant HTML fragments fit its manifest. Hand-wire `prototype serve` + `prototype-decision-bar.html` only when one document has to own every variant (shared CSS/JS/state — the usual shape for a motion prototype; see [ui.md](ui.md) "Motion & animation variants").

**Endpoint security:** dev-only guard, localhost, variant key validated against caller-supplied whitelist for `confirm`; validation skipped for `reject`.

## --publish

When invoked as `/dg:proto ... --publish`, publish the winning variant as a shareable claude.ai Artifact after selection is confirmed.

**Flow (runs after `dg-skills prototype selection wait` resolves `$variant`):**

1. **Fetch the winning variant's HTML.** Preferred: use Playwright MCP (`browser_navigate` to `http://localhost:<port>?variant=<key>`, then `browser_evaluate` with `document.documentElement.outerHTML`). Fallback: `curl -s "http://localhost:<port>?variant=<key>"`.
2. **Strip the switcher bar.** Remove the floating nav/decision bar from the HTML before publishing — it is tooling, not the design being shared.
3. **Write to scratch.** Save the cleaned HTML to `$(~/.dg/bin/dg-skills stash prototype <name>-variant-<key>.html)`.
4. **Publish via Artifact tool.** Title: `<prototype-name> — variant <key>`. Favicon: 🎨. Label: `variant-<key>-selected`. File: the scratch path from step 3.
5. **Print the Artifact URL.**

**Without prior selection** — if `--publish` is passed but no decision has been claimed yet, default to `?variant=A` (or the current URL param if the user is browsing).

**Port resolution order:** the port `dg-skills prototype ui`/`serve` printed (it auto-increments past a taken port) → `$PROTOTYPE_PORT` env var → `4321`. If the port is unknown, ask the user.

**`--light` + `--publish`:** works identically — sentinel path uses `--light` form; HTML fetch and Artifact publish are the same.
