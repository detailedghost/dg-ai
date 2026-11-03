# Install and update DeeGee

**As a Claude Code plugin** (the skills self-bootstrap the CLI on first use):

```text
/plugin marketplace add ~/code/dg
/plugin install dg@detailedghost
/plugin install unslop@detailedghost
```

The `unslop` plugin is optional. It installs the upstream `theclaymethod/unslop` skill, which `/dg:polish` calls
when present.

**Standalone — one command installs `dg-skills`, `dg-daemon` and `dg-agent`
_and_ the browser extension** (no Bun needed; the installer brings its own pinned
runtime):

macOS / Linux (x64 or arm64):

<!-- markdownlint-disable MD013 -->

```bash
curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh
```

Windows (x64 or arm64), in PowerShell:

```powershell
irm https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.ps1 | iex
```

<!-- markdownlint-enable MD013 -->

Both install the pinned Bun runtime and the release bundle into the dg data
folder, write the `dg-skills`, `dg-agent` and `dg-daemon` launchers into the
launcher folder (see [Where dg keeps its files](#where-dg-keeps-its-files)),
then run `dg-skills install`. That
stages the extension and prints the **Load unpacked** steps. Re-run
`dg-skills install` anytime to update. A part that is already current is
skipped. (Building the extension from source with `--local` needs
[Bun](https://bun.sh).)

## Where dg keeps its files

dg follows the conventions of each OS. Install puts the launchers in a
user-writable folder and the rest under four roots, one for each role.

<!-- markdownlint-disable MD013 -->

| Role | Linux | macOS | Windows | `DG_HOME` set |
| --- | --- | --- | --- | --- |
| Launchers | `~/.local/bin` | `~/.local/bin` | `%LOCALAPPDATA%\dg\bin` | `$DG_HOME/bin` |
| Config: `config.json`, the CLI-only marker, channel-review config | `$XDG_CONFIG_HOME/dg` (`~/.config/dg`) | `~/Library/Application Support/dg` | `%APPDATA%\dg` | `$DG_HOME/config` |
| Data: runtime, bundle, skills, personas, browsers | `$XDG_DATA_HOME/dg` (`~/.local/share/dg`) | `~/Library/Application Support/dg` | `%LOCALAPPDATA%\dg` | `$DG_HOME/data` |
| State: daemon, phone, grants, agent sessions and memory | `$XDG_STATE_HOME/dg` (`~/.local/state/dg`) | `~/Library/Application Support/dg/state` | `%LOCALAPPDATA%\dg\state` | `$DG_HOME/state` |
| Cache: prototypes, demos | `$XDG_CACHE_HOME/dg` (`~/.cache/dg`) | `~/Library/Caches/dg` | `%LOCALAPPDATA%\dg\cache` | `$DG_HOME/cache` |
| Logs | `<state>/log` | `~/Library/Logs/dg` | `%LOCALAPPDATA%\dg\log` | `$DG_HOME/log` |

<!-- markdownlint-enable MD013 -->

For example, the phone state is in `~/.local/state/dg/phone` on Linux and in
`~/Library/Application Support/dg/state/phone` on macOS.

When the launcher folder is not on `PATH`, `bootstrap.sh` and
`dg-skills install` print the line to add. `bootstrap.ps1` adds
`%LOCALAPPDATA%\dg\bin` to the user `PATH` once and says so. Skills call
`dg-skills` by name and fall back to `$HOME/.local/bin/dg-skills`.

### DG_HOME

Set `DG_HOME` to keep everything under one folder, for example for a test or a
second install. Each role then gets its own subfolder: `$DG_HOME/bin`,
`$DG_HOME/config`, `$DG_HOME/data`, `$DG_HOME/state`, `$DG_HOME/cache` and
`$DG_HOME/log`. An empty `DG_HOME` counts as unset.

### Move from ~/.dg

Releases before this layout kept everything in `~/.dg` (or flat in `DG_HOME`).
The first `dg-skills install` of a new release moves it:

1. Each folder and file moves to its new root. Install copies it, checks that
   the copy has the same files and sizes, and only then removes the old copy.
   When the check fails, the old copy stays and install names it.
2. Install never writes over a destination that exists. It keeps the old copy
   and says so. When an old folder is still in use after the copy, for example
   the runtime that runs install on Windows, install leaves it and the next
   `dg-skills install` removes it.
3. Install keeps a folder when a process that writes it is still running,
   such as `dg-daemon`. Stop the process and run install again.
4. The phone state moves on the next `dg-agent phone __refresh`, which install
   runs. See [phone](phone.md#where-the-phone-state-lives).
5. Install leaves files it does not know in `~/.dg` and names them once.
   The staged extension folders stay in `~/.dg`, because the browser loads
   them from there.

`~/.dg/bin` keeps small launchers for `dg-skills`, `dg-agent` and
`dg-daemon`. Each prints one line on stderr that names the new launcher and
the release that removes it, then runs the new launcher. The removal release
is two minor releases after the release that moved the data: a move by 1.34.x
names 1.36.0. Install deletes these launchers when it installs that release or
a later one.

Claude Code allow rules in the old form, `Bash(dg-skills <sub>:*)`,
stop matching. `dg-skills doctor` warns and names the new rule,
`Bash(dg-skills <sub>:*)`.

To go back to an older release, first run `dg-agent phone __rollback-home`
to copy the phone state back to `~/.dg/phone`. Then run
`dg-skills install --version <old>`. The older release writes its launchers to
`~/.dg/bin` again. Data under the new roots stays where it is.

## Install layout

One release is one bundle. The three programs share it and one runtime. On
Linux the data folder is `~/.local/share/dg`:

```text
<data>/
  runtime/bun-v1.4.1/bun              the pinned Bun runtime (bun.exe on Windows)
  runtime/current -> bun-v1.4.1       symlink, or a directory junction on Windows
  lib/<version>/dg.js                 the dispatcher; chunks/ holds each program's code
  lib/current -> <version>            the version the launchers run
```

Each launcher in the launcher folder (`.cmd` files on Windows) runs
`<data>/runtime/current/bun <data>/lib/current/dg.js <program>`. The
installer never uses a `bun` on your PATH. It replaces `current` by renaming a
new link over the old one, so a running program keeps working during an
update. The previous version directory stays in `lib/` until the next
successful install, for rollback.

Every download is checked before anything changes. `SHA256SUMS` lists
`runtime.json` and `dg-lib-<version>.tar.gz`, and `runtime.json` lists the
sha256 of each Bun zip. The installer also runs the new bundle's
`dg-skills --version` before it moves `lib/current`. A failed check prints
`checksum mismatch` or the self-check error and leaves the old install as it
was.

On Linux x64 without AVX2, the installer picks Bun's `-baseline` build.

## Update from a compiled-binary install

The bootstrap URLs above never change. Each release publishes `bootstrap.sh`
and `bootstrap.ps1` as assets, and `releases/latest` always points at the
newest one.

Releases before the bundle shipped three compiled binaries. A compiled
`dg-skills install` cannot find the new assets, so update once by re-running
bootstrap:

```bash
curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh
```

On Windows, re-run the `bootstrap.ps1` command above. The new install replaces
the compiled `dg-skills`, `dg-agent` and `dg-daemon` files with launchers and
removes their `.version` stamps. After that, `dg-skills install` updates as
usual.

## Roll back

`dg-skills install --version <previous version>` points `lib/current` at that
version. While its directory is still in `lib/`, nothing is downloaded. To roll
back by hand (Linux path shown):

```bash
ln -sfn <previous version> ~/.local/share/dg/lib/current
```

A version from before the bundle needs that release's own bootstrap script, as
the error message says.

## Bump the Bun runtime

Maintainers change the pinned Bun with one command from a checkout:

```bash
bun scripts/bump-runtime.ts 1.4.2
```

It reads Bun's `SHASUMS256.txt` for that tag and rewrites
`pkg/launcher/runtime.json`, the `bun` pin in `.mise/config.toml` and every
`setup-bun` version in the workflows. `dependency-pinning.spec.ts` fails when
they disagree. The next release ships the new `runtime.json`.
`dg-skills install` then downloads the new runtime once, checks the bundle on
it, and points `runtime/current` at it.

## Update the Claude Code plugin

Pin the marketplace once to the `latest` tag. Do not pin `master`. Set the
same ref in both files:

- `~/.claude/settings.json`: `extraKnownMarketplaces.detailedghost.source.ref`
- `~/.claude/plugins/known_marketplaces.json`: the `detailedghost` source `ref`

Then each release arrives with two commands:

```bash
claude plugin marketplace update detailedghost
claude plugin update dg@detailedghost
```

## Pin a version

Install a specific release instead of the newest, by adding `--version <x.y.z>`
(shell) or setting `DG_VERSION` first (PowerShell):

<!-- markdownlint-disable MD013 -->

```bash
curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh -s -- --version X.Y.Z
```

```powershell
$env:DG_VERSION = "X.Y.Z"
irm https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.ps1 | iex
```

<!-- markdownlint-enable MD013 -->

This pins the bundle, the runtime pin and the extension to that `vX.Y.Z`
release, and combines with `--cli-only`/`--agent-only`. An installed
`dg-skills` accepts the same flag: `dg-skills install --version X.Y.Z`.
Leaving it unset installs the newest release.

If the pinned release does not exist, the whole install fails and names it. It
checks every part first and changes nothing, so a pin never leaves some parts
updated and others not. A pin to a release from before the bundle fails the
same way and prints that release's own bootstrap command.

## Plugin cache

Claude Code keeps every dg plugin version under
`~/.claude/plugins/cache/<marketplace>/dg/<version>/` and removes orphaned ones
about 14 days after it marks them. `dg-skills install` reclaims that space now,
in every mode except `--skills-only` and `--local`, which is a dev build that
never touches release binaries. It prints one line, for example
`plugin cache: removed 1.20.0, 1.21.0 (58 MB); kept 1.24.0 (active)`.

Install keeps a version when any of these is true:

- `installed_plugins.json` names it.
- A session read it in the last 24 hours (the `.in_use` folder changed).
- An `.in_use` entry names a live process.
- It has no `.orphaned_at` marker. Install never deletes a version in an unknown
  state, and prints `kept <version> (unknown state)`.

Install skips the step and prints a reason when `installed_plugins.json` is
unreadable. It never follows a symlink and never touches other plugins or the
marketplace clones. Pass `--keep-cache` to leave the cache alone.

`dg-skills doctor install` reports stale versions and how much space they use.

When `DG_HOME` is set to something other than `~/.dg`, install prints
`note: DG_HOME=<path>; installing there` to stderr before it changes anything,
and `dg-skills doctor` warns.

## CLI-only install

Install the runtime, the bundle and the skills that run without the browser
extension. This skips the extension and its pairing. Run it before using the
plugin so its skills find `dg-skills` and do not start a full install.

<!-- markdownlint-disable MD013 -->

macOS / Linux:

```bash
curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh -s -- --cli-only
```

Windows, in PowerShell:

```powershell
$env:DG_CLI_ONLY = "1"
irm https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.ps1 | iex
```

<!-- markdownlint-enable MD013 -->

`DG_CLI_ONLY=1` works in place of `--cli-only` for the shell form, and an
installed `dg-skills` accepts `dg-skills install --cli-only`. Add `DG_INSTALL_CODEX=1`
to copy only the CLI skills into `$CODEX_HOME/skills`.

| Skill | CLI-only |
| --- | --- |
| `stash`, `proxy` | Yes — proxy needs the selected external backend installed and authenticated |
| `clipboard-img` | Yes — needs a native WSL, Wayland, or X11 clipboard tool |
| `channel-review` | Yes |
| `worktree`, `spec`, `sdlc`, `assign`, `monolith`, `spring-break`, `review-loop`, `polish` | Yes — they call other skills and tools that must be available |
| `jot`, `bg`, `cls`, `stat`, `sniff`, `find-work`, `doctor` | Yes — they call other skills and tools that must be available |
| `db`, `erd` | Yes |
| `pw` | Yes — needs Bun 1.4.0 or later and Chrome, Edge, or a Chromium from `install-browser` |
| `eli5` | Yes for `-v`/`-p` (stash) or `--erd`; a plain `/dg:eli5 <thing>` needs no CLI |
| `ticket` | Yes — needs a stored `ticket/jira` credential |
| `test-live` | Yes — needs Git and an authenticated `gh` (GitHub only) |
| `nope` | No CLI needed — it calls no CLI and no other skill |
| `google-sms-cleanup` | Yes — `dg-skills ssms`; live Google needs a CDP browser, live Signal needs `signal-cli` |
| `inbox-cleanup` | Yes for explicit `--data-path` fixtures; live profiles need `dg-daemon` |
| `browser`, `proto`, `demo` | No — local by default; `--ext` needs the extension |
| `chat`, `overwatch` | No — needs `dg-agent` and `dg-daemon`, which serve the local page on loopback; `--ext` also needs the extension |

On WSL, the default `demo` uses the Windows browser. The CLI controls it through a
remote-debugging port on 127.0.0.1, and the port stays open while the run is live. To
not open that port, use `demo --video --browser chromium` for a headless recording inside WSL.
`--video` alone still uses the Windows browser when one is present.
Any local process can attach to that port during the run. See
[ADR 0029](adr/0029-local-demo-player-wsl-debug-port.md).

`vcs-provider` is also available as a CLI command; it needs Git and authenticated
`gh` (GitHub) or `glab` (GitLab). It has no separate skill. Other workflow skills
without an extension dependency also install; their own tools and referenced
skills still need to be available.

Every skill runs locally by default; only `browser launch` always needs the
extension. A skill run with `--ext` stops with a message that names the fix
when the extension is missing. To add the extension later, run
`dg-skills install` (or the full bootstrap command above). That removes the
CLI-only marker in the dg config folder.

## Skills-only install

Copy the skill instruction files plus the `dg-skills` CLI they call. This path writes
`plugins/dg/skills` (each `SKILL.md` plus the reference files next to it,
including `google-sms-cleanup`) into a directory you choose. Bootstrap copies
the files before any download. It then installs the runtime and the bundle from
the latest `vX.Y.Z` release, checked against that release's `SHA256SUMS`, and
stops. It does not download the extension, and it does not run the text inside
a skill.

From a checkout:

```bash
mise run install:skills
```

Or, with Bun:

```bash
bun pkg/skills-cli/src/index.ts install --skills-only
```

An installed `dg-skills` accepts the same flag. Pass `--repo <checkout>`
when it is not running inside this repository.

<!-- markdownlint-disable MD013 -->

macOS / Linux, without a local checkout:

```bash
curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh -s -- --skills-only
```

Windows, in PowerShell:

```powershell
$env:DG_SKILLS_ONLY = "1"
irm https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.ps1 | iex
```

<!-- markdownlint-enable MD013 -->

`DG_SKILLS_ONLY=1` works in place of `--skills-only` for the shell form.
`DG_SKILLS_DEST` chooses the directory (default: `skills/` in the dg data
folder). Point it at `$CODEX_HOME/skills` when the files should land
where Codex reads skills. The skills root `README.md` is not installed.

## Codex plugin

Install from this repository's Codex marketplace:

```bash
codex plugin marketplace add detailedghost/dg-ai
codex plugin add dg@detailedghost
```

Start a new Codex thread after installation. The shared skills bootstrap the CLI
on first use.

To install the same skills directly into `$CODEX_HOME/skills` without the Codex
plugin, opt in while bootstrapping:

```bash
curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | DG_INSTALL_CODEX=1 sh
```

PowerShell standalone installation:

```powershell
$env:DG_INSTALL_CODEX = "1"
irm https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.ps1 | iex
```

The standalone path copies the skills to `$CODEX_HOME/skills` (or
`~/.codex/skills`). Start a new Codex thread after either installation method.

## Supported browsers

- **Chromium** — Chrome, Edge, Brave, Vivaldi, Opera (single build)
- **Firefox** 139+

See the [agent install guide](AGENT-INSTALL.md) for pairing, local builds, and
the steps that need a person. Read the [browser guide](browser.md) for the
extension’s URL markers and browser-specific behavior.

## Browser download for pw

`dg-skills pw` uses a system Chrome or Edge first. With neither, it exits 3 and
names `dg-skills pw install-browser`. Run that command only when you agree to a
download of about 150 MB. It stores Chromium under `browsers/` in the dg data
folder and records it in `chromium.json`.

`dg-skills doctor pw` reports the result on one line, such as
`browser: chrome (system)`. To remove the download, run
`dg-skills pw install-browser --remove`. It deletes the `browsers/` directory
and nothing else.
