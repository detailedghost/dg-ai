# Install and update DeeGee

**As a Claude Code plugin** (the skills self-bootstrap the CLI on first use):

```text
/plugin marketplace add ~/code/dg
/plugin install dg@detailedghost
/plugin install unslop@detailedghost
```

The `unslop` plugin is optional. It installs the upstream `theclaymethod/unslop` skill, which `/dg:polish` calls
when present. To install every recommended plugin at its pinned commit, see
[Recommended plugins](#recommended-plugins).

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
`dg-skills` by name and fall back to `${DG_HOME:-$HOME/.local}/bin/dg-skills`,
the launcher path, also in the step right after the bootstrap.

### DG_HOME

Set `DG_HOME` to keep everything under one folder, for example for a test or a
second install. Each role then gets its own subfolder: `$DG_HOME/bin`,
`$DG_HOME/config`, `$DG_HOME/data`, `$DG_HOME/state`, `$DG_HOME/cache` and
`$DG_HOME/log`. An empty `DG_HOME` counts as unset.

### Move from ~/.dg

Releases before this layout kept everything in `~/.dg` (or flat in `DG_HOME`).
Any start of `dg-skills`, `dg-agent` or `dg-daemon` moves what is left, before
the command runs. When nothing is left, the check is one folder listing.
[ADR 0036](adr/0036-one-layout-module.md) records the design.

Three terms have one meaning here:

- A target is unused when it holds no rows and no files.
- dg keeps an old copy when it leaves that copy in place and does not remove it.
- An entry is blocked when dg cannot move it now. dg keeps the old copy, and
  the program that writes that state refuses to open it and prints the line
  that says why.

The move follows these rules:

1. Each folder and file moves to its new root. dg copies it, checks that the
   copy has the same files and bytes, and only then removes the old copy.
   When the check fails, dg keeps the old copy and names it.
2. dg never writes over a target that holds data. It keeps the old copy, keeps
   the target, and says so. `dg-skills doctor install` then names both copies.
3. When the target exists and is unused, dg sets it aside as
   `<name>.empty-<ts>`, then moves the old copy in. `dg-skills clean` removes
   the set-aside copy. See [Clean up](#clean-up).
4. When an old folder is still in use after the copy, for example the runtime
   that runs install on Windows, dg leaves it. The next start of any dg
   program removes it and prints one line.
5. When a process that writes a folder is still running, dg blocks that entry.
   Only the daemon's own start and `dg-skills install` stop an old daemon.
   On Linux and macOS they send SIGTERM. When the old daemon is hung and does
   not answer its health check, they first confirm the pid is the dg daemon
   that wrote the pid file, then send SIGTERM and, if it stays, SIGKILL; a pid
   that another program reused gets no signal, and a pid dg cannot identify
   blocks the move. On Windows dg never stops it: it
   prints the service line, and you stop the `dg-daemon` service, then run
   `dg-skills install` again.
6. The phone state moves on any `dg-agent phone` command and on
   `dg-skills install`. See [phone](phone.md#where-the-phone-state-lives).
7. On Linux and macOS, the daemon moves its key in the OS keychain to an
   account named after the new state root. The move runs only when the daemon
   starts to serve, not at the first open. It copies the key, reads it back,
   compares it, and only then deletes the old entry. On macOS, dg passes the
   key to the keychain tool on stdin, so it never appears in the process
   arguments. If any step fails, dg keeps both entries, reads the old account
   when the new one is empty, and prints one warning that names the key,
   never its value. The move is one-way. See the
   [keychain warnings](#keychain-warnings).
8. The staged extension folder moves to the data root. The browser remembers
   the old folder, so install prints one line: open `chrome://extensions`
   once, remove the old `dg-ai-extension` entry, and load unpacked from the
   new folder. Later installs update that folder in place.
9. `ssms` state moves to the state root. Its fixed `config.yaml` moves to
   the config folder under the passwd home, and only `dg-skills install`
   moves it. See [ssms](ssms.md).
10. dg leaves files it does not know in `~/.dg`.
11. A symlinked `~/.dg` keeps its link. dg moves the contents and never
    removes or renames the link.
12. With `DG_HOME` set, the role folders under it stay in place and dg
    moves only the old files next to them.

`~/.dg/bin` keeps small launchers for `dg-skills`, `dg-agent` and
`dg-daemon`. Each prints one line on stderr that names the new launcher and
the release that removes it, then runs the new launcher. The removal release
is two minor releases after the release that moved the data: a move by 1.34.x
names 1.36.0. Install deletes these launchers when it installs that release or
a later one. `dg-skills clean` removes them earlier.

Claude Code allow rules in the old form, `Bash(~/.dg/bin/dg-skills <sub>:*)`,
stop matching. `dg-skills doctor` warns and names the new rule,
`Bash(dg-skills <sub>:*)`.

#### When does it move

| Command | What moves |
| --- | --- |
| `--help`, `-h` anywhere before a `--`, `--version` | Nothing. |
| `dg-skills hooks run`, `dg-agent phone __run`, `dg-daemon status` | Nothing. These commands skip the move. |
| `dg-skills install` | Everything. It stops an old daemon and an old phone listener, moves `runtime/` and `lib/`, then rewrites the launchers and restarts the listener, also when the install fails. |
| `dg-skills doctor` | What it can, before it reports. The `layout` check then lists what is left. |
| `dg-skills clean` | What it can, then it removes the leftovers. |
| `dg-skills spec`, `dg-agent memory` and other commands | The daemon, memory, grants and config. They leave `runtime/`, `lib/`, `phone/` and the ssms config until install (or, for `phone/`, a `dg-agent phone` command) runs. Old `~/.dg/bin` launchers read `runtime/` and `lib/`, and only install rewrites them. |
| `dg-agent phone <verb>` | The phone folder, then the phone-friend lines. |
| `dg-agent start` | The same as `dg-agent` commands. It starts `dg-daemon`, and the daemon's own start moves the daemon folder. |

The keychain key moves only when the daemon serves. The daemon folder can move
days before the key does.

#### Layout lines

Every line goes to stderr. `<from>` is the old path and `<to>` is the new one.
dg prints each line once for each process.

<!-- markdownlint-disable MD013 -->

| Line | Cause | Fix |
| --- | --- | --- |
| `dg: kept <from>; a process that writes it is running. Stop it, then run dg-skills install again` | A live writer holds the entry. dg blocked it. | Stop the process, then run `dg-skills install`. |
| `dg: kept <from>; stop the dg-daemon service, then run dg-skills install again` | On Windows, dg never stops the daemon. | Stop the `dg-daemon` service, then run `dg-skills install`. |
| `dg: <from> has not moved to <to>; run dg-skills install` | A program tried to open an entry that has not moved. This command lacks a step the move needs, such as the phone check or the ssms config folder. | Run `dg-skills install`, or for the phone any `dg-agent phone` command. |
| `dg: copied <from> to <to>; it is in use, so the next dg start removes it` | The copy is complete, but dg could not remove the old copy. The removal is scheduled. | Nothing. The next dg start removes it. |
| `dg: removed <from>; its copy at <to> was complete` | A scheduled removal finished on a later start. | Nothing. |
| `dg: kept <from>; its copy at <to> no longer holds every file` | A scheduled removal found the copy incomplete. | Compare the two folders before you remove either. |
| `dg: set aside unused <to> as <to>.empty-<ts>; dg-skills clean removes it` | The target was unused, so dg renamed it and moved the old copy in. | Run `dg-skills clean` when you want the set-aside copy gone. |
| `dg: kept <from>; <to> already exists and holds data. dg-skills doctor reports both copies` | Both copies hold data. | Run `dg-skills doctor install`, compare the copies, then remove one. |
| `dg: kept <from>; <to> already exists` | A target existed when the copy began. | Run `dg-skills doctor install`, then compare the copies. |
| `dg: kept <from>; the copy failed its check: <problem>` | The copy did not pass the check, for example the phone key check. dg removed the copy. | Fix the problem named, then run `dg-skills install`. |
| `dg: kept <from>; moving it to <to> failed: <reason>` | The copy or its byte check failed. dg removed the copy. | Fix the reason, then run `dg-skills install`. |
| `dg: kept <from>; setting aside <to> failed: <reason>` | dg could not rename the unused target. | Fix the reason, then run `dg-skills install`. |
| `dg: phone-friend lines wait for conversion; run dg-agent phone status` | `dg-agent phone __run` found old phone-friend lines that no command has converted. It exits 1. | Run `dg-agent phone status`. |

<!-- markdownlint-enable MD013 -->

#### Layout check in doctor

`dg-skills doctor install` runs a check with the id `layout`. The check only
reads. It writes nothing.

When every file is in its per-OS folder, the check reports `ok`:
`every dg file is in its per-OS folder`. Otherwise it reports `warn` with one
line for each entry that is left:

| Warn line | Meaning | Who acts |
| --- | --- | --- |
| `<from> has not moved to <to>; run dg-skills install` | dg has not moved the entry. | `dg-skills install` fixes it. |
| `dg: kept <from>; a process that writes it is running. Stop it, then run dg-skills install again` | A live writer blocks the entry. | Stop the process, then `dg-skills install` fixes it. |
| `<from> is copied and waits for removal` | The copy is complete. The old copy waits for removal. | `dg-skills install` or any dg start removes it. |
| `<from> is copied but the copy is incomplete; dg keeps it` | The copy lacks files. dg keeps the old copy. | A human decides. Check both folders first. |
| `<from> and <to> both hold data; compare them, then remove the one you do not need` | A split: both copies hold data. | A human decides. Compare, then remove one. |

The fix line of the warn is `dg-skills install`. On Windows with a live
daemon, it is the service line instead.

#### Keychain warnings

Each line starts with `dg: keychain secret chat-store-kek`. None holds the key.

<!-- markdownlint-disable MD013 -->

| Line, after the prefix | Meaning |
| --- | --- |
| `could not be read from the old account; dg leaves both accounts as they are` | dg cannot read the old entry. It changes nothing. |
| `could not be written to the new account; dg keeps the old entry and reads it from the old account` | The new account refused the key. |
| `did not read back the same from the new account; dg keeps the old entry and reads it from the old account` | The read-back differs from the copy. |
| `differs between the old and the new account; dg reads the new account. If the daemon refuses the key, delete the entry <account> and start the daemon again` | The accounts hold different keys. |
| `moved to the new account, but the old entry could not be deleted; dg reads the new account, and a copy stays in the old one` | The copy succeeded. The old entry stays. |

<!-- markdownlint-enable MD013 -->

### Clean up

`dg-skills clean` removes what the move left behind. It moves what it can
first, then removes these paths:

- Each unused `<name>.empty-<ts>` copy that a move set aside, such as
  `phone.empty-<ts>`. A pending removal that is complete also finishes.
- The `~/.dg/bin` folder, only when every name in it is a dg launcher.
- `~/.dg`, only when it is empty.

It prints one line for each removed path, and a final count:

```text
dg: removed <path>
dg: removed 2 path(s)
```

When it removes `~/.dg/bin`, it also prints one notice:

```text
dg: ~/.dg/bin/dg-skills, ~/.dg/bin/dg-agent and ~/.dg/bin/dg-daemon stop working; the launchers are in <launcher folder>
```

The `~/.dg/bin/<name>` paths stop working now, not at the removal release.
Claude Code allow rules in the old form, `Bash(~/.dg/bin/dg-skills <sub>:*)`,
stop matching. `dg-skills doctor` names the new rule. A later install does not
bring `~/.dg/bin` back.

`dg-skills clean` leaves these paths in place:

- `dg-ai-*` folders. Install removes them.
- A set-aside copy that holds data. It prints
  `dg: kept <path>; it holds data`.
- A `bin` folder that holds other files. It prints
  `dg: kept <path>; it holds files that are not dg launchers: <names>`.
- A pending copy that is still in use.

When a removal fails, it prints
`dg: kept <path>; removing it failed: <reason>`, continues, and exits 1.

It refuses to run while a folder has not moved or an old writer is running. It
prints the fix lines from [Layout lines](#layout-lines), then
`dg: cleaned nothing; fix the lines above, then run dg-skills clean again`,
and exits 1. When nothing is left, it prints `dg: nothing to clean`. It is
safe to run again.

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

### Roll back to a release that uses ~/.dg

No command copies the data back. A release from before the per-OS layout reads
`~/.dg`, so you copy each folder back by hand.

1. Stop every writer.
   - Daemon: it has no `stop` command. Stop the `dg-daemon` service in your
     service manager, or send SIGTERM to the pid in
     `<state>/daemon/daemon.pid` (Linux and macOS).
   - Phone: run `dg-agent phone close`.
   - Channel review: run `dg-skills channel-review stop --env <env>`.
   - ssms: `dg-skills ssms` has no stop command. Let a running `dg-skills ssms`
     command end.
2. Copy each folder back to its `~/.dg` name with a copy that keeps
   attributes. On Linux and macOS, use `cp -a <from> <to>`. On Windows, use
   `robocopy <from> <to> /E /COPY:DAT` for a folder. The table lists the Linux
   paths. `resolveDgPaths` in `pkg/common/src/node/dg-paths.ts` gives the other
   OSes. `memory.db`, `memory.db-wal` and `memory.db-shm` move together. Create
   `~/.dg` with mode 0700 when it does not exist.
3. Run `dg-skills install --version <old>` right away. Every later start on
   the new release logs kept lines until you remove the copies.

| Entry | Per-OS path on Linux | Copy it to |
| --- | --- | --- |
| runtime | `~/.local/share/dg/runtime` | `~/.dg/runtime` |
| lib | `~/.local/share/dg/lib` | `~/.dg/lib` |
| skills | `~/.local/share/dg/skills` | `~/.dg/skills` |
| browsers | `~/.local/share/dg/browsers` | `~/.dg/browsers` |
| demo-narration | `~/.local/share/dg/demo-narration` | `~/.dg/demo-narration` |
| sessions | `~/.local/state/dg/agents/sessions` | `~/.dg/agents/sessions` |
| assets | `~/.local/state/dg/agents/assets` | `~/.dg/agents/assets` |
| memory | `~/.local/state/dg/agents/memory.db`, `memory.db-wal`, `memory.db-shm` | `~/.dg/agents/` |
| personas | `~/.local/share/dg/agents` | `~/.dg/agents` |
| daemon-logs | `~/.local/state/dg/log` | `~/.dg/daemon/logs` |
| daemon | `~/.local/state/dg/daemon` | `~/.dg/daemon` |
| grants | `~/.local/state/dg/grants` | `~/.dg/grants` |
| pairing | `~/.local/state/dg/pairing.json` | `~/.dg/pairing.json` |
| phone | `~/.local/state/dg/phone` | `~/.dg/phone` |
| phone-friend | `~/.local/state/dg/phone-friend` | `~/.dg/phone-friend` |
| inbox | `~/.local/state/dg/inbox` | `~/.dg/inbox` |
| browser-profiles | `~/.local/state/dg/browser-profiles` | `~/.dg/browser-profiles` |
| demo-profile | `~/.local/state/dg/demo-profile` | `~/.dg/demo-profile` |
| channel-review-config | `~/.config/dg/channel-review/config.json` | `~/.dg/channel-review/config.json` |
| channel-review | `~/.local/state/dg/channel-review` | `~/.dg/channel-review` |
| ssms-config | `ssms/config.yaml` in the config folder under the passwd home | `~/.dg/ssms/config.yaml` |
| ssms | `~/.local/state/dg/ssms` | `~/.dg/ssms` |
| proto | `~/.cache/dg/proto` | `~/.dg/proto` |
| demos | `~/.cache/dg/demos` | `~/.dg/demos` |
| config | `~/.config/dg/config.json` | `~/.dg/config.json` |
| cli-only | `~/.config/dg/cli-only` | `~/.dg/cli-only` |

Copy a parent folder before the folder inside it: `daemon` before
`daemon-logs`, `agents` (personas) before `sessions`, `assets` and `memory`, and
`channel-review` before its `config.json`. The `bin` entry is a marker, not a
copy. The older release writes its own launchers to `~/.dg/bin`.

After a rollback, the old release owns `~/.dg`. Before you upgrade again,
remove the per-OS copies you no longer want. Otherwise dg keeps both, and
`dg-skills doctor install` reports a split.

The keychain move is one-way. A daemon from before the per-OS layout (#136)
cannot read the key. The encrypted credentials in `daemon.db` do not decrypt.
Pair again and add the credentials again.

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

## Recommended plugins

Recommended plugins are third-party skills that dg pins but does not
maintain. No dg skill requires them. Every entry in
`.claude-plugin/marketplace.json` except `dg` is one:

- `unslop` removes AI writing patterns from prose. `/dg:polish` calls it when
  present.
- `mattpocock-skills` ships many skills, including `/teach` and `/wait-what`.

Each entry is pinned to a full commit sha. Installs fetch that commit, not the
branch head.

### Install

```bash
dg-skills install --with-recommended
```

The flag is off by default. It works with the default install, `--cli-only` and
`--skills-only`. With `--agent-only`, the command exits 1 before it changes
anything.

With the default install or `--cli-only`, `dg-skills` runs the `claude` CLI to
install each plugin. It first refreshes the `detailedghost` marketplace once.
Claude Code installs the commit that its own `detailedghost` marketplace clone
pins, and that clone follows `master`. `dg-skills` checks the
installed sha against that marketplace pin. When the marketplace pin differs
from the pin in this `dg-skills`, it prints a `note:` line that names both.
When the clone cannot be read, it checks against its own pin. When an installed
sha differs from the expected pin, it uninstalls and installs again. Only
user-scope installs count.

`mattpocock-skills` adds many skill descriptions to every Claude Code session.
That raises the system prompt, so the flag stays opt-in.

### Codex and OpenCode

Use `--skills-only` with `--dest`. A skills-only install copies the dg skills
from a dg-ai checkout, so pass `--repo` with its path, or run the command
inside the checkout:

```bash
dg-skills install --skills-only --repo ~/code/dg-ai --dest ~/.config/opencode/skills --with-recommended
```

`dg-skills` fetches each pinned commit with git. It copies only the regular
tracked files of the declared skill folders that hold a `SKILL.md`. `unslop`
installs as `<dest>/unslop/`. A symlink in the source stops the plugin.

A flat destination skips any skill whose name matches a dg skill. Today those
are `grill-me` and `wayfinder`. Each skip prints a line. The dg copies win
because `/dg:spec` and `/dg:grill-me` link to `/dg:wayfinder`, and wayfinder
runs `dg:grill-me`. In Claude Code, namespaces keep them apart:
`/dg:grill-me` and `/mattpocock-skills:grill-me`.

### Offline behavior

With no network, no `claude` binary, an unknown sha or a sha mismatch, the
plugin prints one warning, `⚠ <plugin> skipped: <reason>`. It installs nothing
for that plugin. If a failure happens while the skills move into place, the
warning reads `⚠ <plugin> failed: <reason>` instead. The dg skills still
install and the command continues.

With the `claude` CLI, `dg-skills` checks the user-scope sha after each install.
If it differs from the pin, `dg-skills` uninstalls the plugin and prints
`⚠ <plugin> removed: installed <sha>, expected <pin>`. If that uninstall fails,
the line reads `⚠ <plugin> skipped: installed <sha>, expected <pin>; uninstall
failed: <reason>`. If the sha cannot be read, the line reads `⚠ <plugin>
installed, but its commit could not be verified`, and the plugin stays.

When the same command also moves `dg-skills` to another version, the running
binary still holds the old pins. It then installs no recommended plugin and
prints `⚠ recommended plugins skipped: dg-skills is now v<version>. Run the
same dg-skills install command again to install them at its pins.`

### Bump a pin

Maintainers move a pin from a checkout:

```bash
bun scripts/bump-plugin-pin.ts unslop
bun scripts/bump-plugin-pin.ts mattpocock-skills --ref main
```

The script reads the ref with `git ls-remote`, rewrites the sha in
`.claude-plugin/marketplace.json` and prints `<name>: <old> -> <new>`. It exits
1 for an unknown name or bad ref, 2 for a missing file and 3 when the repo is
unreachable. Claude Code does not act on a sha change alone, so the next
`dg-skills install --with-recommended` uninstalls and installs the plugin
again.

### Retired and private copies

dg no longer ships `/dg:teach` and `/dg:wait-what`. `/teach` and `/wait-what`
now come from `--with-recommended` as `mattpocock-skills`. A skills install
removes an old `teach` or `wait-what` folder from the destination only when its
`SKILL.md` matches the last dg copy.

If you copied `unslop` by hand, delete the private copies. They shadow the
pinned plugin and never update:

- `~/.claude/skills/unslop`
- `~/.agents/skills/unslop`
- `~/.config/opencode/skills/unslop`

Then reinstall the pinned plugin for your agent.

Claude Code:

```bash
dg-skills install --with-recommended
```

Codex and OpenCode need a dg-ai checkout, as above. Replace `~/code/dg-ai`
with its path.

Codex:

```bash
dg-skills install --skills-only --repo ~/code/dg-ai --dest ~/.codex/skills --with-recommended
dg-skills install --skills-only --repo ~/code/dg-ai --dest ~/.agents/skills --with-recommended
```

OpenCode:

```bash
dg-skills install --skills-only --repo ~/code/dg-ai --dest ~/.config/opencode/skills --with-recommended
```

dg marks each recommended skill folder with a `.dg-recommended` file. It
replaces only folders that have this file. If a folder with the same name is
already there without the file, dg leaves it alone and prints
`skipped <name> (a copy dg did not install is already there)`. Delete that
folder, then run the command again.

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
