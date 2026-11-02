# Extension mode

Everything here except `install` runs only with `--ext` and needs the `dg-ai-extension` loaded in the
browser profile. Plain `batch-open` does not need it. See `install.md` for per-OS
install detail.

## install

`install [chrome|firefox] [--local] [--version <x.y.z>]` stages the extension for a
one-time load **and** refreshes the compiled `dg-skills` binary. It downloads the
CI-built extension zip from the latest `ext-v*` release (or builds locally with
`--local` or in a source checkout) and the platform `dg-skills` binary from the
latest `skills-v*` release. It then prints the browser-specific Load-unpacked
steps. Relay them. The default target is `chrome`, which also serves
Brave, Edge, and Vivaldi.

The `--local` dev path builds the extension from source and needs Bun from
https://bun.sh.

`--version <x.y.z>` pins the skills-v, daemon-v, agent-v, and ext-v release
instead of each one's newest. A missing pinned release, for any of the four,
fails the whole install before anything changes and names the release.

## batch-open --ext

`batch-open --ext [--group <name>] [--repo owner/repo] [--print] <refs…>` opens
the refs in the **default** browser, grouped into `<name>` (default `PRs`), in the
order given. Grouping happens only if the extension is loaded in that profile.

## launch

`launch --ext [--browser <key>] [--group <name>] [--list] [--dry-run] <refs…>`
cold-starts a **Chromium** browser (Brave, Edge, Vivaldi) with the extension
side-loaded through `--load-extension`, then opens the batch. No manual
chrome://extensions step is needed. Use `--list` to see detected browsers. Close
the chosen browser fully first, because the flag applies only on a cold start.
Chrome stable disabled the flag. `launch` does not support Firefox; use
`install firefox`.

## demo and rerun

`demo --ext [--print] <script.json>` encodes the tour script into a
`#_demo=<base64url>` marker on its `startUrl` and opens it in the default browser.
The extension spotlights each step and injects text boxes, then strips the marker.
The demo skill authors and drives the script schema. `--print` emits the marked URL
instead of opening it. Each run also saves a re-runnable
`~/.dg/demos/<slug>/<slug>.demo.md`.

`rerun --ext [--video] [--print] <plan.md>` replays a saved demo plan (written by
`demo` or bundled in a recording's `.zip`) without recompiling. It extracts the
runnable script from the plan's `json` block and hands it to the extension.

## How markers work

`batch-open --ext` and `launch` append a `#_tab_group=<name>` marker to each URL,
and the extension groups those tabs. `demo` appends a `#_demo=` marker, and the
extension plays the tour. In both cases the extension strips the marker after
acting, and only marked tabs are touched. Tabs you open by hand are never grouped.

## Group color

Group color is set in the extension's Options (default **random** per group). The
name comes from `--group` and the batch order from the ref order.
